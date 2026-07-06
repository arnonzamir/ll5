import { logger } from '../utils/logger.js';
import { decrypt } from '../utils/encryption.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';
import { ensureWhatsAppWebhook } from './whatsapp-webhook-config.js';
import type { DispatchDeps } from './whatsapp-dispatch.js';

/**
 * WhatsApp connection lifecycle handling (DECISION-024).
 *
 * Turns Evolution's connection events into (a) an accurate `status` on the
 * account row, (b) proactive agent awareness so the agent can tell the user
 * "WhatsApp dropped / needs a QR scan / reconnected", and (c) a self-heal of
 * the webhook config whenever the instance comes up (so a re-paired instance's
 * default base64:true config is corrected before media can jam the feed).
 *
 * Notifications are transition-gated: connection.update fires constantly with
 * connecting/open flaps, so we only alert the user when the status actually
 * changes into or out of a down state.
 */

const ALERT_KEY = 'whatsapp_disconnected';

/** Normalised account status we persist. */
type WaStatus = 'open' | 'connecting' | 'close' | 'qr' | 'logged_out';

function mapEventToStatus(event: string, data: unknown): WaStatus | null {
  if (event === 'qrcode.updated') return 'qr';
  if (event === 'logout.instance' || event === 'remove.instance') return 'logged_out';
  if (event === 'connection.update') {
    const state = (data as { state?: string } | undefined)?.state;
    if (state === 'open') return 'open';
    if (state === 'connecting') return 'connecting';
    if (state === 'close') return 'close';
  }
  return null; // application.startup and unknowns: no status change, reconcile only
}

async function reconcileWebhook(
  deps: DispatchDeps,
  userId: string,
  instance: string,
  row: { api_url: string | null; api_key: string | null } | null,
): Promise<void> {
  const evolutionApiUrl = row?.api_url || deps.evolutionApiUrl;
  const webhookUrl = deps.webhookPublicUrl;
  const webhookSecret = deps.webhookSecret;
  if (!evolutionApiUrl || !webhookUrl || !webhookSecret) {
    logger.debug('[whatsappLifecycle] reconcile skipped — missing evolution/webhook config');
    return;
  }
  // Prefer the instance's own key (decrypted); fall back to the global key.
  let apiKey: string | undefined;
  if (row?.api_key && deps.encryptionKey) {
    try {
      apiKey = decrypt(row.api_key, deps.encryptionKey);
    } catch {
      /* fall through to global key */
    }
  }
  apiKey = apiKey || deps.evolutionApiKey;
  if (!apiKey) {
    logger.debug('[whatsappLifecycle] reconcile skipped — no evolution apikey available');
    return;
  }
  await ensureWhatsAppWebhook({ evolutionApiUrl, apiKey, instance, webhookUrl, webhookSecret });
}

export async function handleWhatsAppLifecycle(
  deps: DispatchDeps,
  userId: string,
  event: string,
  instance: string | undefined,
  data: unknown,
): Promise<void> {
  const pool = deps.pgPool;
  const newStatus = mapEventToStatus(event, data);

  // Current account row (status + creds for reconcile).
  const cur = await pool
    .query<{ status: string | null; api_url: string | null; api_key: string | null }>(
      'SELECT status, api_url, api_key FROM messaging_whatsapp_accounts WHERE user_id = $1 AND instance_name = $2 LIMIT 1',
      [userId, instance ?? ''],
    )
    .then((r) => r.rows[0] ?? null)
    .catch(() => null);

  const prevStatus = (cur?.status as WaStatus | undefined) ?? undefined;

  // application.startup / open: self-heal the webhook config.
  if (event === 'application.startup' || newStatus === 'open') {
    await reconcileWebhook(deps, userId, instance ?? '', cur);
  }

  if (!newStatus) {
    // No status change (e.g. application.startup) — just touch last_seen.
    if (instance) {
      await pool
        .query('UPDATE messaging_whatsapp_accounts SET last_seen_at = now(), updated_at = now() WHERE user_id = $1 AND instance_name = $2', [userId, instance])
        .catch(() => undefined);
    }
    return;
  }

  // Persist the new status. ($3::text cast — without it Postgres deduces
  // inconsistent types for $3 across the CASE comparison and the column assign.)
  if (instance) {
    const lastError = newStatus === 'logged_out' ? 'logged out — needs re-pairing' : null;
    await pool
      .query(
        `UPDATE messaging_whatsapp_accounts
            SET status = $3,
                last_error = $4,
                last_seen_at = CASE WHEN $3::text = 'open' THEN now() ELSE last_seen_at END,
                updated_at = now()
          WHERE user_id = $1 AND instance_name = $2`,
        [userId, instance, newStatus, lastError],
      )
      .catch((err) => logger.warn('[whatsappLifecycle] status update failed', { error: String(err) }));
  }

  // Paging is intentionally narrow: only `logged_out`/`remove` genuinely needs a
  // re-pair. `qr` is a normal pairing step and `close`/`connecting` flap during
  // reconnects — paging on those spams the user (the 2026-07-06 false "waiting
  // for QR" alert during a live re-pair). Real, sustained, cross-channel outage
  // detection is owned by WhatsAppFlowMonitor.
  const needsRepair = newStatus === 'logged_out';
  const wasNeedsRepair = prevStatus === 'logged_out';

  if (newStatus === 'open') {
    // Always clear a firing disconnect alert on a confirmed open (defensive).
    await clearAlert(pool, userId, ALERT_KEY).catch(() => undefined);
    if (wasNeedsRepair) {
      await insertSystemMessage(
        pool,
        userId,
        'WhatsApp reconnected — message flow has resumed.',
        undefined,
        createSchedulerEvent('whatsapp_connection'),
      ).catch(() => undefined);
      logger.info('[whatsappLifecycle] WhatsApp reconnected', { instance, prevStatus });
    }
    return;
  }

  if (needsRepair && !wasNeedsRepair) {
    await raiseAlert(pool, {
      userId,
      key: ALERT_KEY,
      severity: 'critical',
      summary: 'WhatsApp is logged out and needs re-pairing (scan a QR to reconnect).',
      suggestion: 'Re-pair the WhatsApp instance (scan the QR).',
    }).catch(() => undefined);
    await insertSystemMessage(
      pool,
      userId,
      'WhatsApp is logged out and needs re-pairing. Let the user know, and stop assuming WhatsApp is reaching you until it recovers.',
      { title: 'WhatsApp needs re-pairing', type: 'whatsapp_connection', priority: 'high' },
      createSchedulerEvent('whatsapp_connection'),
    ).catch(() => undefined);
    logger.warn('[whatsappLifecycle] WhatsApp logged out', { instance, prevStatus });
  }
}
