import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';

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
  // Effective timezone resolved fresh at the top of each tick (current GPS zone
  // if recent, else home). Seeded with the static config tz until the first tick.
  private tz: string;

  constructor(
    private pool: Pool,
    private googleClient: GoogleCalendarClient,
    private config: TicklerAlertConfig,
  ) {
    this.tz = config.timezone;
  }

  start(): void {
    logger.info('[TicklerAlertScheduler][start] Tickler alert scheduler started', {
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
      timeZone: this.tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  }

  private getCurrentDate(): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz,
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
    // Resolve the effective tz once per tick so active-hours gating, the daily
    // alerted-IDs reset, and time rendering follow the user's current zone.
    this.tz = await getEffectiveTimezone(this.pool, this.config.userId);

    if (!this.isWithinActiveHours()) return;

    try {
      // The "already alerted today" set lives in tickler_alerts_sent (migration
      // 048), keyed by the LOCAL date: an in-memory set was reset by every gateway
      // deploy and re-announced the same daily ticklers after each restart
      // (2026-09-05: five deploys, "Ritalin 10mg 17:00" twice in 22 minutes).
      const currentDate = this.getCurrentDate();

      const now = new Date();
      const twoHoursLater = new Date(now.getTime() + 2 * 60 * 60 * 1000);

      const ticklers = await this.googleClient.getTicklers(
        now.toISOString(),
        twoHoursLater.toISOString(),
      );
      if (ticklers.length === 0) return;

      const sent = await this.pool.query<{ event_id: string }>(
        `SELECT event_id FROM tickler_alerts_sent WHERE user_id = $1 AND alert_date = $2 AND event_id = ANY($3::text[])`,
        [this.config.userId, currentDate, ticklers.map((t) => t.event_id)],
      );
      const alreadySent = new Set(sent.rows.map((r) => r.event_id));
      const newTicklers = ticklers.filter((t) => !alreadySent.has(t.event_id));
      if (newTicklers.length === 0) return;
      // Mark BEFORE sending so a crash mid-send cannot double-announce.
      await this.pool.query(
        `INSERT INTO tickler_alerts_sent (user_id, event_id, alert_date)
         SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING`,
        [this.config.userId, newTicklers.map((t) => t.event_id), currentDate],
      );

      // Route by kind: user-facing reminders vs agent-private instructions.
      const reminders = newTicklers.filter((t) => (t.kind ?? 'reminder') !== 'instruction');
      const instructions = newTicklers.filter((t) => (t.kind ?? 'reminder') === 'instruction');

      if (reminders.length > 0) {
        const lines: string[] = [
          `[Tickler Alert] ${reminders.length} tickler${reminders.length > 1 ? 's' : ''} due within the next 2 hours:`,
        ];
        for (const tickler of reminders) {
          const due = tickler.all_day ? 'today' : this.formatTime(tickler.start);
          lines.push(`- ${tickler.title} (due: ${due})`);
        }
        lines.push('');
        lines.push('Bring the most time-sensitive one to the user now with a concrete next step. Don\'t just acknowledge silently.');

        const evt = createSchedulerEvent('tickler_alert');
        await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'), {
          title: 'Tickler Alert',
          type: 'tickler_alert',
          priority: 'high',
        }, evt);
        logger.info('[TicklerAlertScheduler][tick] Tickler alert sent', { count: reminders.length });
      }

      // Agent-private instructions: a review YOU scheduled for yourself. Fire one
      // message each (each carries its own complete context), framed as a note to
      // self — not a user reminder, no phone push.
      for (const ins of instructions) {
        const due = ins.all_day ? 'today' : this.formatTime(ins.start);
        const body = [
          `[Agent Instruction] A review you scheduled for yourself is due (${due}):`,
          '',
          (ins.description?.trim() || ins.title),
          '',
          'This is your own note to yourself, not a user reminder. Carry it out now (review / plan / consider, as it says) using the context it carries. Surface something to the user only if your review concludes it deserves their attention; otherwise journal the outcome. A recurring instruction fires again next cycle.',
        ].join('\n');

        const evt = createSchedulerEvent('agent_instruction');
        await insertSystemMessage(this.pool, this.config.userId, body, {
          title: 'Agent Instruction',
          type: 'agent_instruction',
          priority: 'normal',
        }, evt);
        logger.info('[TicklerAlertScheduler][tick] Agent instruction surfaced', { event_id: ins.event_id });
      }
    } catch (err) {
      logger.warn('[TicklerAlertScheduler][tick] Tickler alert tick failed', {
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
      timeZone: this.tz,
    });
  }
}
