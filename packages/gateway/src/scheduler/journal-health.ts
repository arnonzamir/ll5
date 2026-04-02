import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

interface JournalHealthConfig {
  intervalHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Periodic check that the agent is actively journaling.
 * If no journal entries have been written in the configured interval,
 * sends a system message reminding the agent to journal.
 */
export class JournalHealthScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private es: Client,
    private pool: Pool,
    private config: JournalHealthConfig,
  ) {}

  start(): void {
    logger.info('[JournalHealthScheduler][start] Journal health check started', {
      intervalHours: this.config.intervalHours,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
    });
    // Check every 30 minutes
    this.timer = setInterval(() => void this.tick(), 30 * 60 * 1000);
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
      const since = new Date(Date.now() - this.config.intervalHours * 60 * 60 * 1000).toISOString();

      // Count journal entries in the last N hours
      const result = await this.es.count({
        index: 'll5_agent_journal',
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { range: { created_at: { gte: since } } },
            ],
          },
        },
      });

      const entryCount = result.count;

      // Also count how many messages were processed in the same period
      const msgResult = await this.pool.query(
        `SELECT COUNT(*) FROM chat_messages
         WHERE user_id = $1 AND direction = 'inbound' AND created_at > $2`,
        [this.config.userId, since],
      );
      const messageCount = parseInt(msgResult.rows[0].count, 10);

      // If messages were processed but no journal entries written, nudge
      if (messageCount > 3 && entryCount === 0) {
        await insertSystemMessage(
          this.pool,
          this.config.userId,
          `[Journal Check] You've processed ${messageCount} messages in the last ${this.config.intervalHours}h but written 0 journal entries. Remember: after each interaction, either write_journal or consciously skip. Review recent conversations and journal any insights, corrections, or patterns you noticed.`,
        );
        logger.info('[JournalHealthScheduler][tick] Journal nudge sent', {
          messageCount,
          entryCount,
          intervalHours: this.config.intervalHours,
        });
      }
    } catch (err) {
      logger.warn('[JournalHealthScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
