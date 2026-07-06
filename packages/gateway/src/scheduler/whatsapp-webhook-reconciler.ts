import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { ensureWhatsAppWebhook } from '../processors/whatsapp-webhook-config.js';

interface WhatsAppWebhookReconcilerConfig {
  intervalMinutes: number;
  userId: string;
  /** Evolution base URL + GLOBAL apikey (manages any instance, so it works even
   *  for a freshly re-paired instance whose per-instance key we don't hold yet
   *  — this is what closes the cold-start bootstrap gap). */
  evolutionApiUrl: string;
  evolutionApiKey: string;
  webhookUrl: string;
  webhookSecret: string;
}

/**
 * Periodic self-healing of the WhatsApp webhook config (DECISION-024).
 *
 * The event-triggered reconcile (on connection.update→open / application.startup)
 * only fires if the instance already points a webhook at us. A brand-new /
 * re-paired instance with a default config can't notify us — so this pass, using
 * the Evolution GLOBAL key, guarantees every mapped account's webhook converges
 * to base64:false + the full event list regardless. Idempotent; no-op when the
 * config already matches.
 */
export class WhatsAppWebhookReconciler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: WhatsAppWebhookReconcilerConfig,
  ) {}

  start(): void {
    if (!this.config.evolutionApiUrl || !this.config.evolutionApiKey) {
      logger.warn('[WhatsAppWebhookReconciler] disabled — EVOLUTION_API_URL/KEY not set');
      return;
    }
    logger.info('[WhatsAppWebhookReconciler] started', { intervalMinutes: this.config.intervalMinutes });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const res = await this.pool.query<{ instance_name: string; api_url: string | null }>(
        'SELECT instance_name, api_url FROM messaging_whatsapp_accounts WHERE user_id = $1',
        [this.config.userId],
      );
      for (const row of res.rows) {
        const changed = await ensureWhatsAppWebhook({
          evolutionApiUrl: row.api_url || this.config.evolutionApiUrl,
          apiKey: this.config.evolutionApiKey,
          instance: row.instance_name,
          webhookUrl: this.config.webhookUrl,
          webhookSecret: this.config.webhookSecret,
        });
        if (changed) {
          logger.info('[WhatsAppWebhookReconciler] corrected webhook config', { instance: row.instance_name });
        }
      }
    } catch (err) {
      logger.warn('[WhatsAppWebhookReconciler] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
