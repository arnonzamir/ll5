import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface ResponseTimeoutConfig {
  timeoutMinutes: number; // default 2
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Checks for channel messages (WhatsApp/Telegram) that the agent received
 * but hasn't responded to within the timeout window. Sends a push notification
 * to the user and a system message nudging the agent.
 */
export class ResponseTimeoutScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: ResponseTimeoutConfig,
  ) {}

  start(): void {
    logger.info('[ResponseTimeoutScheduler][start] Started', {
      timeoutMinutes: this.config.timeoutMinutes,
    });
    this.timer = setInterval(() => void this.tick(), 30_000); // every 30s
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentHour(): number {
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
      10,
    );
  }

  private async tick(): Promise<void> {
    const hour = this.getCurrentHour();
    if (hour < this.config.startHour || hour >= this.config.endHour) return;

    try { await withSchedulerHealth('response_timeout', async () => {
      // Find user messages (web/android/cli) that are still 'processing' past the timeout.
      // Only checks messages FROM THE USER — not WhatsApp/Telegram system notifications.
      const staleResult = await this.pool.query<{
        id: string;
        content: string;
        channel: string;
        created_at: Date;
        metadata: Record<string, unknown>;
      }>(
        `SELECT id, content, channel, created_at, metadata
         FROM chat_messages
         WHERE user_id = $1
           AND direction = 'inbound'
           AND status = 'processing'
           AND channel IN ('web', 'android', 'cli')
           AND (metadata->>'timeout_notified') IS NULL
           AND created_at < now() - make_interval(mins := $2)
           AND created_at > now() - interval '30 minutes'
         ORDER BY created_at ASC
         LIMIT 5`,
        [this.config.userId, this.config.timeoutMinutes],
      );

      if (staleResult.rows.length === 0) return;

      // Check if agent has sent ANY outbound message recently (it's alive)
      const recentOutbound = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM chat_messages
         WHERE user_id = $1
           AND direction = 'outbound'
           AND created_at > now() - make_interval(mins := $2)`,
        [this.config.userId, this.config.timeoutMinutes],
      );
      const agentActive = parseInt(recentOutbound.rows[0]?.count ?? '0', 10) > 0;

      for (const msg of staleResult.rows) {
        // Mark as notified so we don't re-trigger
        await this.pool.query(
          `UPDATE chat_messages
           SET metadata = metadata || '{"timeout_notified": true}'::jsonb,
               updated_at = now()
           WHERE id = $1`,
          [msg.id],
        );

        const channel = msg.channel ?? 'chat';
        const ageMinutes = Math.round((Date.now() - new Date(msg.created_at).getTime()) / 60000);
        const preview = (msg.content ?? '').slice(0, 80);

        if (agentActive) {
          logger.info('[ResponseTimeoutScheduler] Agent active but message unreplied', {
            messageId: msg.id,
            channel,
            ageMinutes,
          });
          continue;
        }

        logger.warn('[ResponseTimeoutScheduler] Response timeout triggered', {
          messageId: msg.id,
          channel,
          ageMinutes,
        });

        // Send push notification to user's other device
        try {
          // Push to the OTHER device — if user wrote from web, push to android and vice versa
          await sendFCMNotification(this.pool, this.config.userId, {
            title: 'Agent not responding',
            body: `Your message from ${ageMinutes}min ago hasn't been answered`,
            type: 'response_timeout',
            notification_level: 'notify',
          });
        } catch (err) {
          logger.warn('[ResponseTimeoutScheduler] FCM push failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }

        // Insert system message nudging the agent. Route through the shared
        // helper so failures bump the /admin/health.system_messages counter
        // and the per-scheduler health counter.
        const evt = createSchedulerEvent('response_timeout');
        await insertSystemMessage(
          this.pool,
          this.config.userId,
          `[Response Timeout] User sent a message via ${channel} ${ageMinutes} minutes ago and you haven't responded: "${preview}". Reply now.`,
          undefined,
          evt,
        );
      }
    }); } catch {
      // withSchedulerHealth already recorded the failure + logged at error.
    }
  }
}
