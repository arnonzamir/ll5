import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface JournalConsolidationConfig {
  consolidationHour: number;
  timezone: string;
  userId: string;
}

/**
 * Nightly journal consolidation trigger.
 * Sends a system message at the configured hour (default 2am) telling the agent
 * to review the day's journal entries and update the user model.
 */
export class JournalConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunDate: string | null = null;

  constructor(
    private pool: Pool,
    private config: JournalConsolidationConfig,
  ) {}

  start(): void {
    logger.info('[JournalConsolidationScheduler][start] Journal consolidation scheduler started', {
      consolidationHour: this.config.consolidationHour,
      timezone: this.config.timezone,
    });
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
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

  private getCurrentDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()); // YYYY-MM-DD
  }

  private async tick(): Promise<void> {
    try {
      const currentHour = this.getCurrentHour();
      const currentDate = this.getCurrentDate();

      if (currentHour !== this.config.consolidationHour) return;
      if (this.lastRunDate === currentDate) return;

      this.lastRunDate = currentDate;

      const evt = createSchedulerEvent('journal_consolidation');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        '[Journal Consolidation] Time to consolidate. Review today\'s journal entries and session data. Update user model sections as needed. Run /consolidate.\n\nAfter consolidation: 1) call read_user_model() to reload the updated model, 2) push_to_user a brief summary of what changed (level: silent).',
        undefined,
        evt,
      );

      logger.info('[JournalConsolidationScheduler][tick] Consolidation trigger sent');
    } catch (err) {
      logger.warn('[JournalConsolidationScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
