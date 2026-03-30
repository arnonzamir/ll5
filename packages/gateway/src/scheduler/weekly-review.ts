import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

interface WeeklyReviewConfig {
  reviewDay: number; // 0=Sunday, 5=Friday, etc.
  reviewHour: number;
  timezone: string;
  userId: string;
}

/**
 * Weekly review reminder. Sends a system message once per week
 * on the configured day and hour.
 */
export class WeeklyReviewReminder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReviewWeek: number | null = null;

  constructor(
    private pool: Pool,
    private config: WeeklyReviewConfig,
  ) {}

  start(): void {
    logger.info('[WeeklyReviewReminder][start] Weekly review reminder started', {
      reviewDay: this.config.reviewDay,
      reviewHour: this.config.reviewHour,
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
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  }

  private getCurrentDayOfWeek(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.timezone,
      weekday: 'short',
    });
    const dayStr = formatter.format(new Date());
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return dayMap[dayStr] ?? 0;
  }

  private getISOWeekNumber(): number {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  private async tick(): Promise<void> {
    try {
      const currentDay = this.getCurrentDayOfWeek();
      const currentHour = this.getCurrentHour();
      const currentWeek = this.getISOWeekNumber();

      if (currentDay !== this.config.reviewDay) return;
      if (currentHour !== this.config.reviewHour) return;
      if (this.lastReviewWeek === currentWeek) return;

      this.lastReviewWeek = currentWeek;

      await insertSystemMessage(
        this.pool,
        this.config.userId,
        '[Weekly Review] Time for your weekly GTD review. Review all projects, process inbox to zero, review next actions, update waiting-for items, and scan the horizons of focus. Run the weekly review skill or get_gtd_health to start.',
      );

      logger.info('[WeeklyReviewReminder][tick] Weekly review reminder sent', { week: currentWeek });
    } catch (err) {
      logger.warn('[WeeklyReviewReminder][tick] Weekly review tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
