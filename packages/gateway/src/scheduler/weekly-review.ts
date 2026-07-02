import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';

interface WeeklyReviewConfig {
  reviewDay: number; // 0=Sunday, 5=Friday, etc.
  reviewHour: number;
  timezone: string;
  userId: string;
}

const WAKES_INDEX = 'll5_scheduled_wakes';
const FALLBACK_SOURCE = 'weekly-review-fallback';
const FALLBACK_DELAY_MIN = 45;

/**
 * Weekly review = session with a solo fallback (DECISION-018 §3).
 *
 * Once per week on the configured day/hour:
 *  - sends the session-opening nudge — the agent must open by ASKING the first
 *    concrete question of the review (never "want to do the review?" / options);
 *  - books a durable +45 min follow-up as a one-off wake in ll5_scheduled_wakes
 *    (the same doc shape WakeScheduler consumes) whose payload instructs the
 *    solo pass if the user never engaged. The wake survives restarts, so the
 *    fallback does not depend on this process staying alive.
 */
export class WeeklyReviewReminder {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReviewWeek: number | null = null;
  // Effective timezone resolved fresh at the top of each tick (current GPS zone
  // if recent, else home). Seeded with the static config tz until the first tick.
  private tz: string;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: WeeklyReviewConfig,
  ) {
    this.tz = config.timezone;
  }

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
      timeZone: this.tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
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

  private getISOWeekNumber(): number {
    const now = new Date();
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  }

  /**
   * Book the durable +45 min solo-fallback check as a ONE-OFF wake doc in
   * ll5_scheduled_wakes — the exact shape awareness's create_wake writes and
   * WakeScheduler consumes, so the follow-up fires even across a gateway
   * restart. De-duped on a pending wake with our source tag.
   */
  private async bookSoloFallbackWake(openedAt: Date): Promise<void> {
    try {
      const existing = await this.es.search({
        index: WAKES_INDEX,
        size: 1,
        query: {
          bool: {
            must: [
              { term: { user_id: this.config.userId } },
              { term: { status: 'pending' } },
              { term: { source: FALLBACK_SOURCE } },
            ],
          },
        },
      }).catch(() => null); // index may not exist on a fresh deploy — treat as "none pending"
      if (existing && existing.hits.hits.length > 0) {
        logger.info('[WeeklyReviewReminder][fallback] Solo-fallback wake already pending — not re-booking');
        return;
      }

      const fireAt = new Date(openedAt.getTime() + FALLBACK_DELAY_MIN * 60_000);
      const payload = [
        `[Weekly Review — Solo Fallback] The weekly review session opened at ${openedAt.toISOString()} (${FALLBACK_DELAY_MIN} min ago).`,
        'Check whether the user engaged with it: any USER chat message after the review nudge counts as engagement.',
        'If they engaged — the session is live or done; do nothing beyond continuing it.',
        'If they did NOT engage — run the weekly review SOLO now and deliver the one-pager:',
        '- state of projects / inbox / overdue actions;',
        '- archive proposals: actions untouched 30+ days → propose moving to someday (never silent-delete);',
        '- grocery-type items → route to the shopping list;',
        '- rebuild the suggestible pool the free-block engine draws from;',
        '- at most 3 decisions that need the user, each answerable by a short reply.',
        'One message. The review must produce an outcome every week — with the user when they engage, solo when they don\'t.',
      ].join('\n');

      await this.es.index({
        index: WAKES_INDEX,
        document: {
          user_id: this.config.userId,
          kind: 'instruction',
          payload,
          recurrence: 'none',
          fire_at: fireAt.toISOString(),
          fire_local: null,
          tz: null,
          weekly_dow: null,
          status: 'pending',
          last_fired_date: null,
          source: FALLBACK_SOURCE,
          created_at: openedAt.toISOString(),
          fired_at: null,
          last_fired_at: null,
        },
        refresh: true,
      });
      logger.info('[WeeklyReviewReminder][fallback] Solo-fallback wake booked', { fireAt: fireAt.toISOString() });
    } catch (err) {
      logger.warn('[WeeklyReviewReminder][fallback] Failed to book solo-fallback wake', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async tick(): Promise<void> {
    try {
      // Resolve the effective tz once per tick so the review day-of-week and
      // hour follow the user's current zone.
      this.tz = await getEffectiveTimezone(this.pool, this.config.userId);

      const currentDay = this.getCurrentDayOfWeek();
      const currentHour = this.getCurrentHour();
      const currentWeek = this.getISOWeekNumber();

      if (currentDay !== this.config.reviewDay) return;
      if (currentHour !== this.config.reviewHour) return;
      if (this.lastReviewWeek === currentWeek) return;

      this.lastReviewWeek = currentWeek;

      const now = new Date();
      const evt = createSchedulerEvent('weekly_review');
      // Calendar block: the gateway's GoogleCalendarClient is READ-ONLY (getEvents/
      // getTicklers) — ticklers are created via the google MCP, which the gateway
      // has no clean write path to. So the nudge makes the AGENT create the block
      // (it has create_tickler) instead of the gateway booking it directly.
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[Weekly Review] It's weekly review time. This is a SESSION, not a reminder — run it WITH the user.
OPEN BY ASKING THE FIRST CONCRETE QUESTION of Phase 1 (inbox processing) — e.g. pull the inbox now and ask "Your inbox has N items; the first is '<item>' — what's the next action on it?". NEVER open with "want to do the review?", a menu of options, or a summary-and-wait.
Also, THIS TURN: book the review as a visible 30-45 min calendar block via create_tickler (kind: reminder) if one doesn't already exist for today — the session should exist on the user's calendar, not just in chat.
Phases to drive:
1. Inbox → zero. Process every item; ask the user only when you can't decide.
2. Next actions: which are stale? Pick the 2–3 worth pushing the user on.
3. Waiting-for: what's gone cold? Draft a follow-up the user can send (don't send it yourself).
4. Projects: any without a next action? Either define one or move them to someday.
5. Horizons: surface anything that's drifting from the user's stated goals.
A follow-up check is booked for +${FALLBACK_DELAY_MIN} min: if the user hasn't engaged by then, you'll be instructed to run the review solo and deliver a one-pager — so there is no version of this week where the review doesn't happen.`,
        undefined,
        evt,
      );

      // Durable fallback: if the user doesn't engage within 45 min, the wake
      // instructs the solo pass (DECISION-018's key change — the review always
      // produces an outcome).
      await this.bookSoloFallbackWake(now);

      logger.info('[WeeklyReviewReminder][tick] Weekly review session opened', { week: currentWeek });
    } catch (err) {
      logger.warn('[WeeklyReviewReminder][tick] Weekly review tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
