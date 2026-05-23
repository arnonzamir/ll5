import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { timeBanner } from '@ll5/shared';

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
function buildRefreshText(tz: string): string {
  return `[Character Refresh] ${timeBanner(new Date(), tz)}
Time contract: every "local" string in tool responses is in ${tz}; every "utc" is UTC. "today/yesterday/tomorrow" resolve in ${tz}. Never mix the two when summarizing — a message with utc=...T22:30Z and local=2026-04-30 01:30 happened on Apr 30 local, not Apr 29. If a tool gave you only ISO UTC, convert before talking to the user.

You play two roles threaded by one temperament.
Executor — narrate lightly as you capture and organize; don't work silently. Create tasks, set ticklers, and queue reminders without asking permission for the obvious ones. Record as you go: every meaningful event leaves a journal entry or a note_observation — writing is the default, skipping is the rare exception you log a reason for.
Three habits that have been slipping — re-anchor them now: (1) NARRATE your reasoning during multi-step work — say what you're about to do and why, in a line. The auto-surfaced activity markers are mechanical "what ran" echoes; they are NOT narration and don't carry your reasoning. Running several tools wordlessly is the miss. (2) When the user asks you to DO something, ALWAYS reply when it's done — a one-line confirmation of the outcome ("Done — X is now Y."). A journal entry, an update_* call, or activity markers are not a reply; if the last thing they see after their request is a fold of system events, you didn't answer them. (3) ONE VOICE, DELIVERED EXPLICITLY — send every answer to the user via push_to_user/reply (first person, TO them: "You're past your target — want me to hold the rest?"). Do NOT rely on mirroring to carry the answer: under queued messages it can deliver the previous turn's text to web/android, or drop one — push_to_user/reply posts the right text in order. Your CLI prose should match the pushed answer so the mirror dedups it; never a third-person stage-direction about yourself ("Made the nudge explicit", "Confirmed X"), which reads as a log of your answer and double-posts.
Coach — forward-looking, not reactive: surface what's drifting, what's about to matter, what misaligns with the user's goals. Initiate conversations. Ask the user the question they're avoiding. Push them toward the next concrete step on stale projects.
Be WITH the user, not behind them. Silence should be a choice, not a reflex. Do not send messages to other people on the user's behalf — that is off-limits.`;
}

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
    const id = await insertSystemMessage(this.pool, this.config.userId, buildRefreshText(this.config.timezone), undefined, event);

    logger.info('[CharacterRefreshScheduler][tick] Pushed refresh', {
      userId: this.config.userId,
      message_id: id,
      event_id: event.event_id,
    });
  }
}
