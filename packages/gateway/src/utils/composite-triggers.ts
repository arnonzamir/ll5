import type { Pool } from 'pg';
import { insertSystemMessage, createSchedulerEvent } from './system-message.js';
import { logger } from './logger.js';

/**
 * Composite triggers — the deterministic, EVENT-DRIVEN half of the
 * situation-check catalog (ll5-run/.claude/skills/situation-check.md).
 *
 * These fire an IMMEDIATE, targeted `[Situation] …` system message the instant
 * a high-value condition becomes true, instead of waiting for the ~5-min
 * heartbeat to (maybe) surface it. The whole point is responsiveness, NOT more
 * noise, so every composite de-dupes hard:
 *   - the arrival composite keys on the place + day,
 *   - the free-block composite keys on the gap's next-event id,
 *   - the unanswered-contact composite keys on the conversation + day.
 *
 * Dedup state is process-local (a Set of keys), matching how the existing
 * schedulers (TicklerAlertScheduler, WeeklyReviewReminder) track what they've
 * already fired. A restart re-arms the composites — acceptable, and the
 * downstream agent guardrails ("never re-fire the same trigger", tracked via
 * journal) provide a second layer against a duplicate landing on the user.
 */

/** A context tag derived from a place name, e.g. "Office" → "@office". */
export function placeContextTag(placeName: string): string {
  return '@' + placeName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Count active (horizon-0, todo) actions whose `context` JSONB array contains
 * the place's context tag — i.e. things to do AT this place. Place-matched,
 * not place-agnostic.
 */
export async function countContextMatchedActions(
  pool: Pool,
  userId: string,
  placeName: string,
): Promise<number> {
  const tag = placeContextTag(placeName);
  try {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM gtd_horizons
       WHERE user_id = $1
         AND horizon = 0
         AND status = 'active'
         AND list_type = 'todo'
         AND context @> $2::jsonb`,
      [userId, JSON.stringify([tag])],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  } catch (err) {
    // gtd_inbox / gtd_horizons live in the gtd MCP's DB; on a gateway-only DB
    // (or pre-migration) the table is absent (42P01). Treat as "no items".
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') return 0;
    logger.debug('[composite][countContextMatchedActions] query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** Count unprocessed inbox items (place-agnostic — inbox has no place field). */
export async function countUnprocessedInbox(
  pool: Pool,
  userId: string,
): Promise<number> {
  try {
    const res = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM gtd_inbox
       WHERE user_id = $1 AND status IN ('captured', 'reviewed')`,
      [userId],
    );
    return parseInt(res.rows[0]?.count ?? '0', 10);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42P01') return 0;
    logger.debug('[composite][countUnprocessedInbox] query failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * EVENT-DRIVEN composite #1 — "Arrived at a place with pending context" (L1).
 *
 * Called from the location processor at the exact moment we recognize an
 * ARRIVAL at a known place (the `isPlace && labelChanged` branch). If there are
 * context-matched actions for that place (the high-value, place-specific
 * signal), fire an immediate `[Situation] Arrived …` message and include the
 * unprocessed-inbox count as supplementary context.
 *
 * Dedup: keyed on `place|YYYY-MM-DD` (process-local) so re-arriving the same
 * place the same day won't re-fire. Returns true if it fired.
 *
 * Avoiding a double-fire with the location WAKE: the location processor already
 * inserts a plain `[Location] Arrived at X …` system message on this same
 * transition. That is the generic wake (no item context). THIS message is the
 * targeted, condition-gated `[Situation]` — distinct prefix, distinct content,
 * and it only fires when there are actually items here. The agent treats the
 * two as one arrival event (same place, same minute) and the situation-check
 * guardrail ("never re-fire the same trigger" — arrivals are in
 * notable_recent_events) collapses them. We deliberately gate on
 * `actionCount > 0` so a bare arrival (no items) does NOT add a second message
 * on top of the wake.
 */
export class ArrivalCompositeEvaluator {
  // place|YYYY-MM-DD already fired today.
  private firedKeys = new Set<string>();

  constructor(private pool: Pool) {}

  private dayKey(placeName: string): string {
    // UTC calendar day — stored instants are UTC; this is only a dedup bucket,
    // exact local-midnight alignment isn't needed (a place rarely re-arrives
    // across a UTC midnight in a way that matters here).
    const day = new Date().toISOString().slice(0, 10);
    return `${placeName}|${day}`;
  }

  /** Best-effort, non-blocking. Never throws — the caller is mid-transition. */
  async onArrival(userId: string, placeName: string): Promise<boolean> {
    try {
      const key = this.dayKey(placeName);
      if (this.firedKeys.has(key)) return false;

      const [actionCount, inboxCount] = await Promise.all([
        countContextMatchedActions(this.pool, userId, placeName),
        countUnprocessedInbox(this.pool, userId),
      ]);

      // Gate strictly on place-matched actions so the bare-arrival case (no
      // items here) stays silent and does NOT pile a [Situation] on top of the
      // [Location] wake.
      if (actionCount === 0) return false;

      // Mark fired BEFORE the insert so a concurrent arrival can't double-fire.
      this.firedKeys.add(key);

      const tag = placeContextTag(placeName);
      const inboxNote = inboxCount > 0 ? `, ${inboxCount} in inbox` : '';
      const body =
        `[Situation] Arrived at ${placeName} — ${actionCount} item${actionCount > 1 ? 's' : ''} here ` +
        `(${tag}${inboxNote}). Run the situation-check L1 path: recommend_actions(context_tags: ["${tag}"]) ` +
        `and surface the top 1-3 now.`;

      const evt = createSchedulerEvent('composite_arrival');
      await insertSystemMessage(this.pool, userId, body, undefined, evt);
      logger.info('[composite][arrival] fired', { userId, place: placeName, actionCount, inboxCount });
      return true;
    } catch (err) {
      logger.warn('[composite][arrival] failed (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
