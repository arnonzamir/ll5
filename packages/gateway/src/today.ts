import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { countTrayItems } from './tray.js';
import { getEffectiveTimezone, endOfDayInTz } from './utils/timezone.js';
import { logger } from './utils/logger.js';

/**
 * Today card plane (android-companion-ui Phase 2 — the ambient anchor).
 *
 * Two routes, both chatAuth (the agent's channel holds a user token, so the
 * SAME auth serves the phone reading and the agent writing):
 *
 *   POST /today-card — the agent upserts today's first-person "voice" read +
 *                      the single focus ("one thing") into day_cards.
 *   GET  /me/today   — the phone's one aggregation call: voice + next event +
 *                      habit day-dots + needs-you count + quiet-since.
 *
 * VOICE (binding — android-companion-ui.md §5a): Today LEADS with the agent's
 * voice; habit dots and the needs-you row are subordinate furniture. This
 * plane only stores/serves — the words themselves come from the persona.
 *
 * FROZEN CONTRACT — the Android app and the ll5-run persona are built against
 * these exact shapes.
 */

// ---------------------------------------------------------------------------
// Frozen response shapes
// ---------------------------------------------------------------------------

export type HabitDayState = 'done' | 'missed' | 'excused' | 'skipped' | 'open' | 'none';

export interface TodayHabitDay {
  /** YYYY-MM-DD in the habit's own timezone. */
  date: string;
  state: HabitDayState;
}

export interface TodayHabit {
  habit_id: string;
  name: string;
  /** Exactly 14 entries, oldest first, last = today (habit-tz day boundaries). */
  days: TodayHabitDay[];
}

export interface TodayResponse {
  voice: string | null;
  one_thing: string | null;
  voice_updated_at: string | null;
  next_event: {
    title: string;
    /** HH:MM (24h) in the user's effective timezone. */
    start_local: string;
    start_iso: string;
    location: string | null;
    /** When the calendar was queried — the card's provenance line. */
    as_of: string;
  } | null;
  habits: TodayHabit[];
  needs_you_count: number;
  quiet_since: string | null;
}

const VOICE_MAX = 400;
const ONE_THING_MAX = 200;
const CALENDAR_INDEX = 'll5_awareness_calendar_events';

// ---------------------------------------------------------------------------
// Local-day helpers (pure calendar arithmetic — no host-tz leakage)
// ---------------------------------------------------------------------------

/** The local calendar date (YYYY-MM-DD) of an instant in a zone. */
function localDateInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** YYYY-MM-DD minus n days — pure calendar math via Date.UTC (tz-free). */
function minusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - n));
  return t.toISOString().slice(0, 10);
}

/** Day-of-week (0=Sunday) of a calendar date — matches gtd_habits schedule.days. */
function dowOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** HH:MM (24h) of an instant in a zone. */
function hhmmInTz(date: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

/** True when the table is missing (pre-migration deploy) — log and degrade. */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

interface DayCardRow { voice: string | null; one_thing: string | null; updated_at: Date | string }

async function readDayCard(
  pool: Pool,
  userId: string,
  day: string,
): Promise<{ voice: string | null; one_thing: string | null; voice_updated_at: string | null }> {
  let row: DayCardRow | undefined;
  try {
    const res = await pool.query<DayCardRow>(
      `SELECT voice, one_thing, updated_at FROM day_cards WHERE user_id = $1 AND day = $2`,
      [userId, day],
    );
    row = res.rows[0];
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[today][dayCard] day_cards missing (pre-migration) — empty card');
      return { voice: null, one_thing: null, voice_updated_at: null };
    }
    throw err;
  }
  if (!row) return { voice: null, one_thing: null, voice_updated_at: null };
  return {
    voice: row.voice,
    one_thing: row.one_thing,
    voice_updated_at: new Date(row.updated_at).toISOString(),
  };
}

interface CalendarHit {
  _source?: { title?: string; start_time?: string; location?: string | null };
}

/**
 * Next upcoming calendar event TODAY (user's effective tz) from the same ES
 * index the calendar review reads (ll5_awareness_calendar_events — populated
 * by CalendarSyncScheduler, the google MCP and phone pushes).
 *
 * Excluded: kind=instruction ticklers (agent-private review notes — the same
 * filter the calendar review applies) and all-day events (no meaningful
 * "HH:MM next up" — mirrors the heartbeat's context query; today's all-day
 * docs start at/before local midnight anyway, so they are never "upcoming").
 */
async function readNextEvent(
  es: Client,
  userId: string,
  now: Date,
  tz: string,
): Promise<TodayResponse['next_event']> {
  const asOf = now.toISOString();
  const result = await es.search({
    index: CALENDAR_INDEX,
    query: {
      bool: {
        filter: [
          { term: { user_id: userId } },
          { range: { start_time: { gte: asOf, lt: endOfDayInTz(now, tz).toISOString() } } },
        ],
        must_not: [
          { term: { kind: 'instruction' } },
          { term: { all_day: true } },
        ],
      },
    },
    sort: [{ start_time: 'asc' }],
    size: 1,
    _source: ['title', 'start_time', 'location'],
  });

  const hit = (result.hits.hits as CalendarHit[]).find((h) => h._source?.start_time);
  if (!hit?._source?.start_time) return null;
  const start = new Date(hit._source.start_time);
  return {
    title: hit._source.title ?? '(untitled)',
    start_local: hhmmInTz(start, tz),
    start_iso: start.toISOString(),
    location: hit._source.location ?? null,
    as_of: asOf,
  };
}

interface HabitRow {
  id: string;
  name: string;
  schedule: { days?: 'daily' | number[]; times?: string[] } | null;
  timezone: string | null;
}

interface HabitLogRow { due_date: string; due_time: string; outcome: string | null }

const OUTCOME_TO_STATE: Record<string, HabitDayState> = {
  done: 'done',
  missed: 'missed',
  excused: 'excused',
  skipped_deliberate: 'skipped',
};

/**
 * Collapse one calendar day of a habit into a single dot state.
 *
 * Rules (per-day aggregation across the habit's scheduled times):
 *  - not scheduled that day (or no times)         → 'none'
 *  - TODAY with any occurrence not yet logged     → 'open' (day still live —
 *    even a not-yet-due evening dose keeps the dot open, honestly)
 *  - logged outcomes: worst wins — missed > skipped > excused > done
 *  - PAST day with nothing logged                 → 'none' (scheduled-but-no-
 *    row; also covers a NULL-outcome row the end-of-day sweep hasn't closed —
 *    the sweep owns 'missed', this endpoint never invents it)
 */
function dayState(scheduledTimes: string[], logs: HabitLogRow[], isToday: boolean): HabitDayState {
  if (scheduledTimes.length === 0) return 'none';

  const byTime = new Map(logs.map((l) => [l.due_time, l.outcome]));
  const outcomes = scheduledTimes
    .map((t) => byTime.get(t))
    .filter((o): o is string => o != null);

  if (isToday && outcomes.length < scheduledTimes.length) return 'open';
  if (outcomes.length === 0) return 'none';

  for (const worst of ['missed', 'skipped_deliberate', 'excused'] as const) {
    if (outcomes.includes(worst)) return OUTCOME_TO_STATE[worst];
  }
  return 'done';
}

/**
 * Active habits with a 14-day dot strip each (oldest first, last = today).
 * Day boundaries are computed in the HABIT's timezone (falling back to the
 * user's effective tz) — the same zone the scheduler and tray use, so a dot
 * flips days exactly when the habit's own day does.
 */
async function collectHabitStrips(pool: Pool, userId: string, now: Date): Promise<TodayHabit[]> {
  let habits: HabitRow[];
  try {
    const res = await pool.query<HabitRow>(
      `SELECT id, name, schedule, timezone
       FROM gtd_habits
       WHERE user_id = $1 AND status = 'active'
       ORDER BY created_at`,
      [userId],
    );
    habits = res.rows;
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[today][habits] gtd_habits missing (pre-migration) — no strips');
      return [];
    }
    throw err;
  }
  if (habits.length === 0) return [];

  const effectiveTz = await getEffectiveTimezone(pool, userId);
  const strips: TodayHabit[] = [];

  for (const habit of habits) {
    const zone = habit.timezone || effectiveTz;
    const today = localDateInTz(now, zone);
    const windowStart = minusDays(today, 13);

    let logs: HabitLogRow[] = [];
    try {
      const res = await pool.query<HabitLogRow>(
        `SELECT due_date::text AS due_date, due_time, outcome
         FROM gtd_habit_log
         WHERE habit_id = $1 AND user_id = $2 AND due_date BETWEEN $3 AND $4`,
        [habit.id, userId, windowStart, today],
      );
      logs = res.rows;
    } catch (err) {
      if (!isMissingTable(err)) throw err;
    }

    const byDate = new Map<string, HabitLogRow[]>();
    for (const log of logs) {
      const list = byDate.get(log.due_date) ?? [];
      list.push(log);
      byDate.set(log.due_date, list);
    }

    const scheduleDays = habit.schedule?.days ?? 'daily';
    const times = habit.schedule?.times ?? [];

    const days: TodayHabitDay[] = [];
    for (let i = 13; i >= 0; i -= 1) {
      const date = minusDays(today, i);
      const scheduled = scheduleDays === 'daily'
        || (Array.isArray(scheduleDays) && scheduleDays.includes(dowOf(date)));
      days.push({
        date,
        state: dayState(scheduled ? times : [], byDate.get(date) ?? [], date === today),
      });
    }

    strips.push({ habit_id: habit.id, name: habit.name, days });
  }
  return strips;
}

/**
 * "Quiet since" — v1 SIMPLIFICATION (documented, deliberate): tracking when
 * the last needs-you item was RESOLVED would need per-item resolution
 * timestamps across three sources, so instead: null whenever something needs
 * you (the card shows the needs-you row, not quiet), else the created_at of
 * the newest assistant chat message on any channel as a cheap "last activity"
 * proxy. Good enough for "Quiet since 14:20 — nothing needs you".
 */
async function readQuietSince(pool: Pool, userId: string, needsYouCount: number): Promise<string | null> {
  if (needsYouCount > 0) return null;
  const res = await pool.query<{ created_at: Date | string }>(
    `SELECT created_at FROM chat_messages
     WHERE user_id = $1 AND role = 'assistant'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId],
  );
  const row = res.rows[0];
  return row ? new Date(row.created_at).toISOString() : null;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface TodayRouterOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createTodayRouter(
  pool: Pool,
  es: Client,
  authSecret: string,
  options: TodayRouterOptions = {},
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const nowFn = options.now ?? (() => new Date());

  // POST /today-card — the agent writes today's voice + one thing. Full
  // replace (not a patch): the body IS the card; re-writing during the day
  // is the intended flow. "Today" resolves in the user's effective tz.
  router.post('/today-card', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { voice, one_thing: oneThing } = (req.body ?? {}) as { voice?: unknown; one_thing?: unknown };

    if (typeof voice !== 'string' || voice.length === 0) {
      res.status(400).json({ error: 'voice must be a non-empty string' });
      return;
    }
    if (voice.length > VOICE_MAX) {
      res.status(400).json({ error: `voice must be at most ${VOICE_MAX} characters` });
      return;
    }
    if (oneThing != null && typeof oneThing !== 'string') {
      res.status(400).json({ error: 'one_thing must be a string or null' });
      return;
    }
    if (typeof oneThing === 'string' && oneThing.length > ONE_THING_MAX) {
      res.status(400).json({ error: `one_thing must be at most ${ONE_THING_MAX} characters` });
      return;
    }

    try {
      const tz = await getEffectiveTimezone(pool, userId);
      const day = localDateInTz(nowFn(), tz);
      await pool.query(
        `INSERT INTO day_cards (user_id, day, voice, one_thing, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (user_id, day)
         DO UPDATE SET voice = EXCLUDED.voice, one_thing = EXCLUDED.one_thing, updated_at = now()`,
        [userId, day, voice, oneThing ?? null],
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'day_card',
        entity_id: day,
        summary: `Today card ${day} updated (voice ${voice.length} chars${oneThing ? ', one thing set' : ''})`,
        metadata: { day, has_one_thing: oneThing != null },
      });

      res.json({ status: 'ok' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[today][postCard] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /me/today — the Today screen's single aggregation call.
  router.get('/me/today', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const now = nowFn();
      const tz = await getEffectiveTimezone(pool, userId);
      const today = localDateInTz(now, tz);

      const [card, nextEvent, habits, needsYouCount] = await Promise.all([
        readDayCard(pool, userId, today),
        readNextEvent(es, userId, now, tz),
        collectHabitStrips(pool, userId, now),
        countTrayItems(pool, userId, now),
      ]);
      const quietSince = await readQuietSince(pool, userId, needsYouCount);

      const payload: TodayResponse = {
        voice: card.voice,
        one_thing: card.one_thing,
        voice_updated_at: card.voice_updated_at,
        next_event: nextEvent,
        habits,
        needs_you_count: needsYouCount,
        quiet_since: quietSince,
      };
      res.json(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[today][get] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
