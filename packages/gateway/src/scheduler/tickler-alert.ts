import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

interface TicklerAlertConfig {
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Alerts for ticklers due within the next 2 hours.
 * Runs periodically during active hours, tracking already-alerted IDs per day.
 */
export class TicklerAlertScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private alertedIds: Set<string> = new Set();
  private lastAlertDate: string | null = null;

  constructor(
    private pool: Pool,
    private googleClient: GoogleCalendarClient,
    private config: TicklerAlertConfig,
  ) {}

  start(): void {
    logger.info('Tickler alert scheduler started', {
      intervalMinutes: this.config.intervalMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
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
    return formatter.format(new Date());
  }

  private isWithinActiveHours(): boolean {
    const hour = this.getCurrentHour();
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  private async tick(): Promise<void> {
    if (!this.isWithinActiveHours()) return;

    try {
      // Reset alerted IDs when date changes
      const currentDate = this.getCurrentDate();
      if (this.lastAlertDate !== currentDate) {
        this.alertedIds.clear();
        this.lastAlertDate = currentDate;
      }

      const now = new Date();
      const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const ticklers = await this.googleClient.getTicklers(
        now.toISOString(),
        twoHoursLater.toISOString(),
      );

      // Filter out already-alerted ticklers
      const newTicklers = ticklers.filter((t) => !this.alertedIds.has(t.event_id));
      if (newTicklers.length === 0) return;

      const lines: string[] = [
        `[Tickler Alert] ${newTicklers.length} tickler${newTicklers.length > 1 ? 's' : ''} due within the next 2 hours:`,
      ];

      for (const tickler of newTicklers) {
        const due = tickler.all_day
          ? 'today'
          : this.formatTime(tickler.start);
        lines.push(`- ${tickler.title} (due: ${due})`);
        this.alertedIds.add(tickler.event_id);
      }

      await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'));
      logger.info('Tickler alert sent', { count: newTicklers.length });
    } catch (err) {
      logger.warn('Tickler alert tick failed', {
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
}
