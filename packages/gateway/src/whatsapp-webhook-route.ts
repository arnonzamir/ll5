import crypto from 'node:crypto';
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { ContactRoutingResolver } from './processors/contact-routing.js';
import { dispatchEvolutionEvent, type DispatchDeps } from './processors/whatsapp-dispatch.js';
import { resolveWhatsAppUserId } from './utils/whatsapp-user-resolver.js';
import { isSourceEnabled } from './utils/data-source-config.js';
import type { WhatsAppQueue } from './utils/whatsapp-queue.js';
import { logger } from './utils/logger.js';

export interface WhatsappWebhookDeps {
  pgPool: Pool;
  esClient: Client;
  notificationMatcher: ContactRoutingResolver;
  /** Required shared secret. Evolution API must send this in `X-Webhook-Secret`. */
  webhookSecret: string;
  encryptionKey: string | undefined;
  /** RabbitMQ ingest queue. When up, events are enqueued and processed by a
   *  worker; when down (or disabled) the ingress processes inline (no loss). */
  queue: WhatsAppQueue;
  /** Evolution creds + public webhook URL for the self-healing reconciler. */
  evolutionApiUrl?: string;
  evolutionApiKey?: string;
  webhookPublicUrl?: string;
}

/** Constant-time compare for fixed-length secrets. Returns false on length mismatch
 *  so timingSafeEqual never throws. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createWhatsappWebhookRouter(deps: WhatsappWebhookDeps): Router {
  const router = Router();

  const dispatchDeps: DispatchDeps = {
    pgPool: deps.pgPool,
    esClient: deps.esClient,
    notificationMatcher: deps.notificationMatcher,
    encryptionKey: deps.encryptionKey,
    evolutionApiUrl: deps.evolutionApiUrl,
    evolutionApiKey: deps.evolutionApiKey,
    webhookPublicUrl: deps.webhookPublicUrl,
    webhookSecret: deps.webhookSecret,
  };

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
        // Acknowledge to Evolution but do not process.
        res.json({ status: 'ok' });
        return;
      }

      // Fast path: enqueue and ack immediately so Evolution's serial delivery is
      // never blocked by our processing (the 2026-07-06 head-of-line-block).
      const enqueued = await deps.queue.publish({
        userId,
        payload,
        receivedAt: new Date().toISOString(),
      });
      if (enqueued) {
        res.json({ status: 'queued' });
        return;
      }

      // Broker down / disabled → process inline so nothing is lost.
      // `payload` is defined here — `instanceName` was read from it above.
      await dispatchEvolutionEvent(dispatchDeps, userId, payload as Record<string, unknown>);
      res.json({ status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[whatsappWebhook] Processing failed', { error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}
