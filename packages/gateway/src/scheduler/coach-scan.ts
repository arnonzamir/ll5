import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface CoachScanConfig {
  /** Day of week to fire (0=Sunday … 6=Saturday). */
  scanDay: number;
  /** Hour of day (0-23) to fire, in the user's effective timezone. */
  scanHour: number;
  timezone: string;
  userId: string;
}

/**
 * Weekly strategic-review scheduler. Once per week, on the configured day +
 * hour (in the user's EFFECTIVE timezone), it wakes the agent to run its
 * `coach-scan` skill — a deliberately slower, forward-looking pass over goals,
 * narratives, commitments, and the 2-4-week calendar horizon.
 *
 * This is the strategic counterpart to the tactical WeeklyReviewReminder
 * (GTD inbox-zero / next-actions). It fires its own [Coach Scan] system
 * message and de-dupes to once per ISO week.
 */
export class CoachScanScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastScanWeek: number | null = null;
  // Effective timezone resolved fresh at the top of each tick (current GPS zone
  // if recent, else home). Seeded with the static config tz until the first tick.
  private tz: string;

  constructor(
    private pool: Pool,
    private config: CoachScanConfig,
  ) {
    this.tz = config.timezone;
  }

  start(): void {
    logger.info('[CoachScanScheduler][start] Coach scan scheduler started', {
      scanDay: this.config.scanDay,
      scanHour: this.config.scanHour,
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
      timeZone: this.tz,
      hour: 'numeric',
      hour12: false,
    });
    return (parseInt(formatter.format(new Date()), 10) % 24);
  }

  private getCurrentDayOfWeek(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.tz,
      weekday: 'short',
    });
    const dayStr = formatter.format(new Date());
    const dayMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    return dayMap[dayStr] ?? 0;
  }

  /** ISO week number — the once-per-week dedup key. */
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
      await withSchedulerHealth('coach_scan', async () => {
        // Resolve the effective tz once per tick so the scan day-of-week and
        // hour follow the user's current zone (mirrors the other schedulers).
        this.tz = await getEffectiveTimezone(this.pool, this.config.userId);

        const currentDay = this.getCurrentDayOfWeek();
        const currentHour = this.getCurrentHour();
        const currentWeek = this.getISOWeekNumber();

        if (currentDay !== this.config.scanDay) return;
        if (currentHour !== this.config.scanHour) return;
        if (this.lastScanWeek === currentWeek) return;

        this.lastScanWeek = currentWeek;

        const evt = createSchedulerEvent('coach_scan');
        await insertSystemMessage(
          this.pool,
          this.config.userId,
          `[Coach Scan] Weekly strategic review — run the coach-scan skill: scan goals/narratives/commitments/calendar 2-4 weeks out, schedule instruction-ticklers for future reviews, surface at most one coaching message.`,
          undefined,
          evt,
        );

        logger.info('[CoachScanScheduler][tick] Coach scan cue sent', { week: currentWeek });
      });
    } catch (err) {
      // withSchedulerHealth already recorded + logged the failure; swallow here
      // so a bad tick never crashes the interval.
      logger.warn('[CoachScanScheduler][tick] Coach scan tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
