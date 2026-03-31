import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

interface HeartbeatConfig {
  silenceMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Heartbeat scheduler — nudges the agent with the current time
 * if no system messages have been sent for a configured period.
 * Keeps the agent time-aware during quiet periods.
 */
export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: HeartbeatConfig,
  ) {}

  start(): void {
    logger.info('[HeartbeatScheduler][start] Heartbeat started', {
      silenceMinutes: this.config.silenceMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
    });
    // Check every 5 minutes
    this.timer = setInterval(() => void this.tick(), 5 * 60 * 1000);
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

    try {
      // Check when the last system message was sent
      const result = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM chat_messages
         WHERE user_id = $1 AND channel = 'system' AND direction = 'inbound'
         ORDER BY created_at DESC LIMIT 1`,
        [this.config.userId],
      );

      if (result.rows.length === 0) return;

      const lastMessage = result.rows[0].created_at;
      const silenceMs = Date.now() - new Date(lastMessage).getTime();
      const silenceMinutes = silenceMs / (60 * 1000);

      if (silenceMinutes < this.config.silenceMinutes) return;

      // Format current time in user timezone
      const now = new Date();
      const time = now.toLocaleTimeString('en-GB', {
        timeZone: this.config.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const day = now.toLocaleDateString('en-US', {
        timeZone: this.config.timezone,
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });

      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[Time Check] It's ${time} on ${day}. Anything that needs attention?`,
      );

      logger.info('[HeartbeatScheduler][tick] Time check sent', { time, silence: Math.round(silenceMinutes) });
    } catch (err) {
      logger.warn('[HeartbeatScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
