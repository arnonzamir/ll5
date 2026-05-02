import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface GTDHealthConfig {
  intervalHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Periodic GTD health check reminder.
 * Sends a system message prompting Claude to run get_gtd_health.
 */
export class GTDHealthScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckTime: number = 0;

  constructor(
    private pool: Pool,
    private config: GTDHealthConfig,
  ) {}

  start(): void {
    logger.info('[GTDHealthScheduler][start] GTD health scheduler started', {
      intervalHours: this.config.intervalHours,
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

  private isWithinActiveHours(): boolean {
    const hour = this.getCurrentHour();
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  private async tick(): Promise<void> {
    if (!this.isWithinActiveHours()) return;

    const now = Date.now();
    const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
    if (now - this.lastCheckTime < intervalMs) return;

    try {
      this.lastCheckTime = now;

      const evt = createSchedulerEvent('gtd_health');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[GTD Health Check] Run get_gtd_health, then act on what you find — don't just summarize.
- Overdue or due-today actions: surface the top 1–2 to the user with a concrete next step.
- Stalled projects (no activity in 7+ days): pick one and push the user toward the next concrete action.
- Empty inbox? Good — confirm and move on.
- If the user is mid-conversation about something else, hold the prompt and bring it up at the right beat. If they're idle, start the conversation.
You're allowed to create tasks, set ticklers, and ask questions without checking first. You are NOT allowed to send messages on the user's behalf.`,
        undefined,
        evt,
      );

      logger.info('[GTDHealthScheduler][tick] GTD health check reminder sent');
    } catch (err) {
      logger.warn('[GTDHealthScheduler][tick] GTD health tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
