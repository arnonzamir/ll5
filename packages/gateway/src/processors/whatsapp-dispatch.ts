import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { ContactRoutingResolver } from './contact-routing.js';
import { processWhatsAppWebhook } from './whatsapp-webhook.js';
import { processWhatsAppContactWebhook } from './whatsapp-contact-webhook.js';
import { handleWhatsAppLifecycle } from './whatsapp-lifecycle.js';
import { logger } from '../utils/logger.js';
import { recordBridgeEvent } from '../utils/whatsapp-bridge-liveness.js';

/**
 * Shared WhatsApp event dispatch (DECISION-024).
 *
 * The single place an Evolution event is turned into side effects, called from
 * BOTH the RabbitMQ consumer worker (the normal path) and the ingress inline
 * fallback (when the broker is down). Keeping one implementation guarantees the
 * two paths never drift.
 *
 * The caller (ingress) has already verified the shared secret and resolved
 * instance → userId; dispatch assumes a trusted, attributed payload.
 */

export interface DispatchDeps {
  pgPool: Pool;
  esClient: Client;
  notificationMatcher: ContactRoutingResolver;
  encryptionKey: string | undefined;
  /** Evolution admin creds for the self-healing webhook reconciler (optional). */
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  /** Public URL Evolution should POST events to (for reconcile). */
  webhookPublicUrl?: string;
  /** Shared secret Evolution must send back (for reconcile). */
  webhookSecret?: string;
}

export async function dispatchEvolutionEvent(
  deps: DispatchDeps,
  userId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const event = payload?.event as string | undefined;
  const instance = payload?.instance as string | undefined;
  // Ground truth for the flow monitor (ISS-013): every event proves the bridge
  // is alive, even when nobody is messaging (receipts, chat updates at night).
  recordBridgeEvent(userId, event, payload?.data);

  // --- Connection lifecycle: login / start / logout / QR (DECISION-024) ------
  if (
    event === 'connection.update' ||
    event === 'application.startup' ||
    event === 'logout.instance' ||
    event === 'remove.instance' ||
    event === 'qrcode.updated'
  ) {
    await handleWhatsAppLifecycle(deps, userId, event, instance, payload.data);
    return;
  }

  // --- Contacts --------------------------------------------------------------
  if (event === 'contacts.upsert' || event === 'contacts.update') {
    const contacts = (Array.isArray(payload?.data) ? payload.data : []) as Parameters<
      typeof processWhatsAppContactWebhook
    >[2];
    await processWhatsAppContactWebhook(deps.pgPool, userId, contacts);
    return;
  }

  // --- Chats (archive / unread state) ----------------------------------------
  if (event === 'chats.upsert' || event === 'chats.update') {
    const chats = Array.isArray(payload?.data) ? (payload.data as Record<string, unknown>[]) : [];
    for (const chat of chats) {
      const jid = (chat.remoteJid ?? chat.id) as string | undefined;
      if (!jid) continue;
      const archived = (chat.archive ?? chat.archived ?? null) as boolean | null;
      const unreadCount = (chat.unreadCount ?? null) as number | null;
      if (archived === null && unreadCount === null) continue;

      const updates: string[] = [];
      const values: unknown[] = [];
      let pi = 1;
      if (archived !== null) {
        updates.push(`is_archived = $${pi++}`);
        values.push(archived);
      }
      if (unreadCount !== null) {
        updates.push(`unread_count = $${pi++}`);
        values.push(unreadCount);
      }
      updates.push('updated_at = now()');
      values.push(userId, jid);
      await deps.pgPool
        .query(
          `UPDATE messaging_conversations SET ${updates.join(', ')} WHERE user_id = $${pi++} AND conversation_id = $${pi}`,
          values,
        )
        .catch((err) => {
          logger.warn('[whatsappDispatch] Failed to update conversation', {
            error: err instanceof Error ? err.message : String(err),
            jid,
          });
        });
    }
    return;
  }

  // --- Messages (the hot path) ----------------------------------------------
  await processWhatsAppWebhook(
    deps.esClient,
    deps.pgPool,
    deps.notificationMatcher,
    userId,
    payload as unknown as Parameters<typeof processWhatsAppWebhook>[4],
    deps.encryptionKey,
  );
}
