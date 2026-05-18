import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { NotificationRuleMatcher } from './processors/notification-rules.js';
import { processWhatsAppWebhook } from './processors/whatsapp-webhook.js';
import { processWhatsAppContactWebhook } from './processors/whatsapp-contact-webhook.js';
import { resolveWhatsAppUserId } from './utils/whatsapp-user-resolver.js';
import { isSourceEnabled } from './utils/data-source-config.js';
import { logger } from './utils/logger.js';

export interface WhatsappWebhookDeps {
  pgPool: Pool;
  esClient: Client;
  notificationMatcher: NotificationRuleMatcher;
  /** Required shared secret. Evolution API must send this in `X-Webhook-Secret`. */
  webhookSecret: string;
  encryptionKey: string | undefined;
}

/** Constant-time compare for fixed-length secrets. Returns false on length mismatch
 *  so timingSafeEqual never throws. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createWhatsappWebhookRouter(deps: WhatsappWebhookDeps): Router {
  const router = Router();

  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const provided = req.headers['x-webhook-secret'];
    if (typeof provided !== 'string' || !safeEqual(provided, deps.webhookSecret)) {
      logger.warn('[whatsappWebhook] Rejected: missing or invalid X-Webhook-Secret');
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  };

  router.post('/', authMiddleware, async (req: Request, res: Response) => {
    try {
      const payload = req.body as Record<string, unknown> | undefined;
      const instanceName = payload?.instance;
      if (typeof instanceName !== 'string' || instanceName.length === 0) {
        res.status(400).json({ error: 'Missing instance field' });
        return;
      }

      // No fallback: unknown instance = 404. Never attribute a webhook to a
      // user whose mapping we cannot verify.
      const userId = await resolveWhatsAppUserId(deps.pgPool, instanceName, undefined);
      if (!userId) {
        logger.warn('[whatsappWebhook] Unknown instance', { instanceName });
        res.status(404).json({ error: 'Unknown instance' });
        return;
      }

      if (!(await isSourceEnabled(deps.pgPool, userId, 'whatsapp'))) {
        // Acknowledge to Evolution API but do not process
        res.json({ status: 'ok' });
        return;
      }

      const event = payload?.event as string | undefined;
      if (event === 'contacts.upsert' || event === 'contacts.update') {
        const contacts = (Array.isArray(payload?.data) ? payload.data : []) as Parameters<
          typeof processWhatsAppContactWebhook
        >[2];
        await processWhatsAppContactWebhook(deps.pgPool, userId, contacts);
        res.json({ status: 'ok' });
        return;
      }

      if (event === 'chats.upsert' || event === 'chats.update') {
        const chats = Array.isArray(payload?.data) ? (payload.data as Record<string, unknown>[]) : [];
        for (const chat of chats) {
          const jid = (chat.remoteJid ?? chat.id) as string | undefined;
          if (!jid) continue;
          const archived = (chat.archive ?? chat.archived ?? null) as boolean | null;
          const unreadCount = (chat.unreadCount ?? null) as number | null;
          if (archived !== null || unreadCount !== null) {
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
                logger.warn('[whatsappWebhook] Failed to update conversation', {
                  error: err instanceof Error ? err.message : String(err),
                  jid,
                });
              });
          }
        }
        res.json({ status: 'ok' });
        return;
      }

      await processWhatsAppWebhook(
        deps.esClient,
        deps.pgPool,
        deps.notificationMatcher,
        userId,
        payload as unknown as Parameters<typeof processWhatsAppWebhook>[4],
        deps.encryptionKey,
      );
      res.json({ status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[whatsappWebhook] Processing failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}
