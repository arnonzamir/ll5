import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface ReviewConfig {
  startHour: number;
  endHour: number;
  intervalMinutes: number;
  timezone: string;
  userId: string;
}

/**
 * Periodic calendar review that sends system channel messages.
 * Runs every N minutes during configured hours, with a fuller morning review.
 */
export class CalendarReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReviewTime: Date | null = null;

  constructor(
    private pool: Pool,
    private googleClient: GoogleCalendarClient,
    private config: ReviewConfig,
  ) {}

  start(): void {
    logger.info('[CalendarReviewScheduler][start] Calendar review scheduler started', {
      startHour: this.config.startHour,
      endHour: this.config.endHour,
      intervalMinutes: this.config.intervalMinutes,
      timezone: this.config.timezone,
    });

    // Check every minute whether it is time for a review
    this.timer = setInterval(() => void this.tick(), 60_000);
    // Also check immediately
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

  private getCurrentMinute(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.timezone,
      minute: 'numeric',
    });
    return parseInt(formatter.format(new Date()), 10);
  }

  private isWithinActiveHours(): boolean {
    const hour = this.getCurrentHour();
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  private isMorningReviewTime(): boolean {
    const hour = this.getCurrentHour();
    const minute = this.getCurrentMinute();
    return hour === this.config.startHour && minute < 5; // First 5 minutes of start hour
  }

  private shouldRunReview(): boolean {
    if (!this.isWithinActiveHours()) return false;

    if (!this.lastReviewTime) return true;

    const elapsed = Date.now() - this.lastReviewTime.getTime();
    return elapsed >= this.config.intervalMinutes * 60 * 1000;
  }

  private async tick(): Promise<void> {
    if (!this.shouldRunReview()) return;

    try {
      const isMorning = this.isMorningReviewTime() && (
        !this.lastReviewTime ||
        Date.now() - this.lastReviewTime.getTime() > 60 * 60 * 1000
      );

      if (isMorning) {
        await this.runMorningReview();
      } else {
        await this.runPeriodicReview();
      }
      this.lastReviewTime = new Date();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[CalendarReviewScheduler][tick] Calendar review tick failed', { error: message });
    }
  }

  private async runMorningReview(): Promise<void> {
    logger.info('[CalendarReviewScheduler][runMorningReview] Running morning calendar review');

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

    const lines: string[] = [`[Morning Calendar Review] Today is ${dayName}.`];

    if (todayEvents.length > 0) {
      lines.push('');
      lines.push('SCHEDULE:');
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
      lines.push('TICKLERS:');
      for (const tickler of ticklers) {
        const due = tickler.all_day
          ? this.formatDate(tickler.start)
          : this.formatTime(tickler.start);
        lines.push(`- ${tickler.title} (due: ${due})`);
      }
    }

    await this.sendSystemMessage(lines.join('\n'));
    logger.info('[CalendarReviewScheduler][runMorningReview] Morning review sent', { events: todayEvents.length, ticklers: ticklers.length });
  }

  private async runPeriodicReview(): Promise<void> {
    logger.debug('[CalendarReviewScheduler][runPeriodicReview] Running periodic calendar review');

    const now = new Date();
    const fourHoursLater = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

    const [upcomingEvents, ticklers] = await Promise.all([
      this.googleClient.getEvents(now.toISOString(), fourHoursLater.toISOString()),
      this.googleClient.getTicklers(
        new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
        endOfDay.toISOString(),
      ),
    ]);

    // Only send a message if there are upcoming events or ticklers
    if (upcomingEvents.length === 0 && ticklers.length === 0) {
      logger.debug('[CalendarReviewScheduler][runPeriodicReview] Nothing upcoming in next 4 hours');
      return;
    }

    const lines: string[] = ['[Calendar Review] Coming up:'];

    for (const event of upcomingEvents) {
      const minutesUntil = Math.round((new Date(event.start).getTime() - now.getTime()) / 60000);
      const timeLabel = minutesUntil <= 0
        ? 'now'
        : minutesUntil < 60
          ? `in ${minutesUntil} min`
          : `in ${Math.round(minutesUntil / 60)}h`;
      let line = `- ${this.formatTime(event.start)} ${event.title} (${timeLabel})`;
      if (event.location) {
        line += ` @ ${event.location}`;
      }
      lines.push(line);
    }

    if (ticklers.length > 0) {
      lines.push('TICKLERS DUE TODAY:');
      for (const tickler of ticklers) {
        lines.push(`- ${tickler.title}`);
      }
    }

    await this.sendSystemMessage(lines.join('\n'));
    logger.info('[CalendarReviewScheduler][runPeriodicReview] Periodic review sent', { events: upcomingEvents.length, ticklers: ticklers.length });
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

  private async sendSystemMessage(content: string): Promise<void> {
    const evt = createSchedulerEvent('calendar_review');
    await insertSystemMessage(this.pool, this.config.userId, content, undefined, evt);
  }
}
