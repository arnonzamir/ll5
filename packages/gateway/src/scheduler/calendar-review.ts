import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone, startOfDayInTz, endOfDayInTz } from '../utils/timezone.js';

interface ReviewConfig {
  startHour: number;
  endHour: number;
  intervalMinutes: number;
  timezone: string;
  userId: string;
}

// DECISION-018 §4 / DECISION-020 §2: the mechanical prep obligation appended to
// every calendar-review nudge. "Naming the prep" measurably never became a
// booking (1 ping_later in 932 moments) — the rule makes the booking itself the
// contract, and the behavior.forward_work_stalled anomaly check is its backstop.
const PREP_OBLIGATION =
  'PREP OBLIGATION: For each event in the next 48h that needs prep, BOOK the prep THIS TURN (create_wake or tickler) — naming it is not enough; the governor only credits ping_later when a booking exists.';

/**
 * Periodic calendar review that sends system channel messages.
 * Runs every N minutes during configured hours, with a fuller morning review.
 */
export class CalendarReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReviewTime: Date | null = null;
  // Effective timezone resolved fresh at the top of each tick (current GPS zone
  // if recent, else home). Seeded with the static config tz until the first tick.
  private tz: string;

  constructor(
    private pool: Pool,
    private googleClient: GoogleCalendarClient,
    private config: ReviewConfig,
  ) {
    this.tz = config.timezone;
  }

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
      timeZone: this.tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  }

  private getCurrentMinute(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.tz,
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
    // Resolve the effective tz once per tick so active-hours gating, day
    // boundaries, and time rendering all follow the user's current zone.
    this.tz = await getEffectiveTimezone(this.pool, this.config.userId);

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
    const startOfDay = startOfDayInTz(now, this.tz);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const endOfTomorrow = new Date(endOfDay.getTime() + 24 * 60 * 60 * 1000);

    const [todayEvents, ticklers] = await Promise.all([
      this.googleClient.getEvents(startOfDay.toISOString(), endOfDay.toISOString()),
      this.googleClient.getTicklers(startOfDay.toISOString(), endOfTomorrow.toISOString())
        .then((ts) => ts.filter((t) => (t.kind ?? 'reminder') !== 'instruction')),
    ]);

    const dayName = now.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      timeZone: this.tz,
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

    lines.push('');
    lines.push(PREP_OBLIGATION);

    await this.sendSystemMessage(lines.join('\n'));
    logger.info('[CalendarReviewScheduler][runMorningReview] Morning review sent', { events: todayEvents.length, ticklers: ticklers.length });
  }

  private async runPeriodicReview(): Promise<void> {
    logger.debug('[CalendarReviewScheduler][runPeriodicReview] Running periodic calendar review');

    const now = new Date();
    const fourHoursLater = new Date(now.getTime() + 4 * 60 * 60 * 1000);
    const startOfDay = startOfDayInTz(now, this.tz);
    const endOfDay = endOfDayInTz(now, this.tz);

    const [upcomingEvents, ticklers] = await Promise.all([
      this.googleClient.getEvents(now.toISOString(), fourHoursLater.toISOString()),
      this.googleClient.getTicklers(
        startOfDay.toISOString(),
        endOfDay.toISOString(),
      ).then((ts) => ts.filter((t) => (t.kind ?? 'reminder') !== 'instruction')),
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

    lines.push('');
    lines.push(PREP_OBLIGATION);

    await this.sendSystemMessage(lines.join('\n'));
    logger.info('[CalendarReviewScheduler][runPeriodicReview] Periodic review sent', { events: upcomingEvents.length, ticklers: ticklers.length });
  }

  private formatTime(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: this.tz,
    });
  }

  private formatDate(isoString: string): string {
    const date = new Date(isoString);
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: this.tz,
    });
  }

  private async sendSystemMessage(content: string): Promise<void> {
    const evt = createSchedulerEvent('calendar_review');
    await insertSystemMessage(this.pool, this.config.userId, content, undefined, evt);
  }
}
