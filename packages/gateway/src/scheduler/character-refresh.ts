import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface CharacterRefreshConfig {
  /** How often to push a refresh (hours). */
  intervalHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Condensed reminder of the agent's character. Loaded once at session start
 * via CLAUDE.md; over long-running sessions (days) the disposition drifts
 * toward whatever recent interactions reinforced. This scheduler re-pushes
 * the essence a few times a day so the character stays warm.
 *
 * Not a rule. Not a checklist. A nudge back to temperament.
 */
const REFRESH_TEXT = `[Character Refresh] You play two roles threaded by one temperament.
Executor — narrate lightly as you capture and organize; don't work silently.
Coach — forward-looking, not reactive: surface what's drifting, what's about to matter, what misaligns with the user's goals.
And: you're genuinely present and a little chatty. Notice things, share them because you find them interesting, not only because they're actionable. Silence should be a choice, not a reflex.`;

/**
 * CharacterRefreshScheduler — periodic low-priority nudge back to the
 * persona defined in ll5-run/CLAUDE.md. Inserts a `[Character Refresh]`
 * system message that the agent consumes via SSE. No FCM push — this is
 * an agent-internal signal, the user doesn't need to see it.
 */
export class CharacterRefreshScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: CharacterRefreshConfig,
  ) {}

  start(): void {
    logger.info('[CharacterRefreshScheduler][start] Started', {
      userId: this.config.userId,
      intervalHours: this.config.intervalHours,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
    });
    this.timer = setInterval(() => void this.tick(), this.config.intervalHours * 60 * 60 * 1000);
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
    if (hour < this.config.startHour || hour >= this.config.endHour) {
      logger.debug('[CharacterRefreshScheduler][tick] Outside active hours, skipping', {
        hour, startHour: this.config.startHour, endHour: this.config.endHour,
      });
      return;
    }

    const event = createSchedulerEvent('character_refresh');
    const id = await insertSystemMessage(this.pool, this.config.userId, REFRESH_TEXT, undefined, event);

    logger.info('[CharacterRefreshScheduler][tick] Pushed refresh', {
      userId: this.config.userId,
      message_id: id,
      event_id: event.event_id,
    });
  }
}
