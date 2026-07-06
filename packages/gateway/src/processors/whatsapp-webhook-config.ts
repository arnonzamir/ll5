import { logger } from '../utils/logger.js';

/**
 * Self-healing WhatsApp webhook reconciler (DECISION-024).
 *
 * Every time an Evolution instance is recreated or re-paired it gets a DEFAULT
 * webhook config — crucially `webhookBase64: true`, which inlines base64 media
 * into the webhook body and 413s the gateway's 1 MB limit (the 2026-07-06
 * outage). Rather than hand-fix it after every re-pair, the gateway reconciles
 * the webhook to the desired config: base64 OFF (the gateway fetches media
 * separately via getBase64FromMediaMessage anyway), the shared secret header,
 * and the full event list including the connection-lifecycle events.
 *
 * Idempotent: reads the current webhook, only POSTs when it has drifted.
 */

/** Evolution event names (UPPER_SNAKE in the webhook `events` array). Includes
 *  the connection-lifecycle events so the agent sees login/start/logout. */
export const DESIRED_EVENTS = [
  'MESSAGES_UPSERT',
  'MESSAGES_UPDATE',
  'CONNECTION_UPDATE',
  'QRCODE_UPDATED',
  'APPLICATION_STARTUP',
  'LOGOUT_INSTANCE',
  'REMOVE_INSTANCE',
  'CONTACTS_UPSERT',
  'CHATS_UPSERT',
  'CHATS_UPDATE',
  'CHATS_DELETE',
] as const;

export interface WebhookConfigTarget {
  /** Evolution base URL, e.g. https://evolution.noninoni.click */
  evolutionApiUrl: string;
  /** Evolution apikey — the instance's own key OR the global key. */
  apiKey: string;
  /** Instance name, e.g. `ll5`. */
  instance: string;
  /** Public URL Evolution should POST to. */
  webhookUrl: string;
  /** Shared secret sent as X-Webhook-Secret. */
  webhookSecret: string;
}

interface EvolutionWebhookState {
  url?: string;
  enabled?: boolean;
  webhookBase64?: boolean;
  webhookByEvents?: boolean;
  events?: string[];
  headers?: Record<string, string>;
}

const FETCH_HEADERS = (apiKey: string) => ({
  'Content-Type': 'application/json',
  apikey: apiKey,
  // Explicit UA — Cloudflare WAF 403s some default agents (2026-05-22 incident).
  'User-Agent': 'll5-gateway/whatsapp-reconciler',
});

function desiredMatches(cur: EvolutionWebhookState | null, t: WebhookConfigTarget): boolean {
  if (!cur) return false;
  if (cur.enabled !== true) return false;
  if (cur.webhookBase64 !== false) return false;
  if (cur.url !== t.webhookUrl) return false;
  if (cur.headers?.['X-Webhook-Secret'] !== t.webhookSecret) return false;
  const want = new Set(DESIRED_EVENTS);
  const have = new Set(cur.events ?? []);
  if (have.size !== want.size) return false;
  for (const e of want) if (!have.has(e)) return false;
  return true;
}

/**
 * Ensure the instance's webhook matches the desired config. Returns whether a
 * change was applied. Never throws — logs and returns false on any error so a
 * reconcile pass can't crash a caller (consumer / scheduler).
 */
export async function ensureWhatsAppWebhook(t: WebhookConfigTarget): Promise<boolean> {
  try {
    const findRes = await fetch(`${t.evolutionApiUrl}/webhook/find/${t.instance}`, {
      method: 'GET',
      headers: FETCH_HEADERS(t.apiKey),
    });
    let current: EvolutionWebhookState | null = null;
    if (findRes.ok) {
      current = (await findRes.json()) as EvolutionWebhookState;
    } else if (findRes.status !== 404) {
      logger.warn('[whatsappWebhookConfig] find failed', { instance: t.instance, status: findRes.status });
    }

    if (desiredMatches(current, t)) return false;

    const body = {
      webhook: {
        enabled: true,
        url: t.webhookUrl,
        headers: { 'X-Webhook-Secret': t.webhookSecret },
        byEvents: false,
        base64: false,
        events: [...DESIRED_EVENTS],
      },
    };
    const setRes = await fetch(`${t.evolutionApiUrl}/webhook/set/${t.instance}`, {
      method: 'POST',
      headers: FETCH_HEADERS(t.apiKey),
      body: JSON.stringify(body),
    });
    if (!setRes.ok) {
      logger.error('[whatsappWebhookConfig] set failed', { instance: t.instance, status: setRes.status });
      return false;
    }
    logger.info('[whatsappWebhookConfig] webhook reconciled', {
      instance: t.instance,
      wasBase64: current?.webhookBase64 ?? null,
      wasEnabled: current?.enabled ?? null,
    });
    return true;
  } catch (err) {
    logger.error('[whatsappWebhookConfig] reconcile error', {
      instance: t.instance,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
