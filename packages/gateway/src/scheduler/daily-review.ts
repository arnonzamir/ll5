import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface DailyReviewConfig {
  reviewHour: number;
  timezone: string;
  userId: string;
}

/**
 * Morning briefing scheduler. Runs once per day at the configured hour.
 * Fetches today's events and ticklers, then sends a system message summary.
 */
export class DailyReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReviewDate: string | null = null;

  constructor(
    private pool: Pool,
    private googleClient: GoogleCalendarClient,
    private config: DailyReviewConfig,
  ) {}

  start(): void {
    logger.info('[DailyReviewScheduler][start] Daily review scheduler started', {
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

  private getCurrentDate(): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return formatter.format(new Date()); // YYYY-MM-DD
  }

  private async tick(): Promise<void> {
    try {
      const currentHour = this.getCurrentHour();
      const currentDate = this.getCurrentDate();

      if (currentHour !== this.config.reviewHour) return;
      if (this.lastReviewDate === currentDate) return;

      this.lastReviewDate = currentDate;

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
      const endOfTomorrow = new Date(endOfDay.getTime() + 24 * 60 * 60 * 1000);

      const [todayEvents, ticklers] = await Promise.all([
        this.googleClient.getEvents(startOfDay.toISOString(), endOfDay.toISOString()),
        this.googleClient.getTicklers(startOfDay.toISOString(), endOfTomorrow.toISOString()),
      ]);

      const dayName = now.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        timeZone: this.config.timezone,
      });

      const lines: string[] = [`[Morning Briefing] Good morning! Today is ${dayName}.`];

      if (todayEvents.length > 0) {
        lines.push('');
        lines.push(`You have ${todayEvents.length} event${todayEvents.length > 1 ? 's' : ''} today:`);
        for (const event of todayEvents) {
          const time = event.all_day
            ? 'All day'
            : this.formatTime(event.start);
          let line = `- ${time}: ${event.title}`;
          if (event.location) {
            line += ` (${event.location})`;
          }
          lines.push(line);
        }
      } else {
        lines.push('No calendar events today — open day.');
      }

      if (ticklers.length > 0) {
        lines.push('');
        lines.push(`${ticklers.length} tickler${ticklers.length > 1 ? 's' : ''} due today/tomorrow:`);
        for (const tickler of ticklers) {
          const due = tickler.all_day
            ? this.formatDate(tickler.start)
            : this.formatTime(tickler.start);
          lines.push(`- ${tickler.title} (due: ${due})`);
        }
      }

      const evt = createSchedulerEvent('morning_briefing');
      await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'), {
        title: 'Morning Briefing',
        type: 'morning_briefing',
        priority: 'normal',
      }, evt);
      logger.info('[DailyReviewScheduler][tick] Morning briefing sent', { events: todayEvents.length, ticklers: ticklers.length });
    } catch (err) {
      logger.warn('[DailyReviewScheduler][tick] Daily review tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.config.timezone,
    });
  }

  private formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: this.config.timezone,
    });
  }
}
