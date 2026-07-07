import type { Pool } from 'pg';
import { logger } from './utils/logger.js';

/**
 * Reconciliation mutation gate (DECISION-025 D5/D6) — the deterministic,
 * server-side seam every signal-driven loop mutation goes through. The
 * off-agent worker can only mutate loop state via this gate; the safety
 * properties are enforced HERE, not in the worker's prompt.
 *
 * Invariant (D6): reconciliation may change TRACKING state (close/advance a
 * loop, mark reviewed) — it may NEVER, by itself, send/pay or irreversibly
 * delete. Those are simply not operations this gate exposes.
 *
 * Stakes routing (D5, deterministic on the DB stamp — never a per-close
 * judgment): a `consequential` loop is NEVER autonomously closed by a signal
 * (forgery: a plausible "close it out" lie reads the same as a real
 * resolution). It is advanced + surfaced for the user's one-tap confirm; the
 * confirmed close is committed by `confirmReconcileClose`. A `low` loop may
 * auto-close. The stamp defaults to `consequential`, so the gate fails safe.
 *
 * Atomicity (D3): the close/advance and the `reviewed_at` stamp are one
 * transaction — a crash can't leave a stamped-but-unclosed or closed-but-
 * unstamped loop. Every statement is `user_id`-scoped.
 */

export type ReconcileAction = 'close' | 'advance' | 'keep_open';
export type ReconcileResult = 'closed' | 'reviewed' | 'needs_confirm' | 'not_found';

/**
 * Apply a signal-driven reconciliation to one loop, atomically. Returns:
 *  - 'closed'        — a low-stakes loop was completed + stamped.
 *  - 'needs_confirm' — a consequential loop was advanced (stamped reviewed) and
 *                      must be surfaced for the user's one-tap confirm; NOT closed.
 *  - 'reviewed'      — advance / keep-open: stamped reviewed, left active.
 *  - 'not_found'     — no such active loop for this user.
 */
export async function applyReconcile(
  pool: Pool,
  userId: string,
  loopId: string,
  action: ReconcileAction,
): Promise<ReconcileResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ stakes: string }>(
      `SELECT stakes FROM gtd_horizons
        WHERE id = $1 AND user_id = $2 AND horizon = 0 AND status = 'active'
        FOR UPDATE`,
      [loopId, userId],
    );
    if (cur.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'not_found';
    }
    const consequential = cur.rows[0].stakes === 'consequential';

    // A consequential loop is never autonomously closed: downgrade close→advance,
    // stamp reviewed, and flag for confirm. Low-stakes close proceeds.
    if (action === 'close' && !consequential) {
      await client.query(
        `UPDATE gtd_horizons
            SET status = 'completed', completed_at = now(), reviewed_at = now(), updated_at = now()
          WHERE id = $1 AND user_id = $2`,
        [loopId, userId],
      );
      await client.query('COMMIT');
      return 'closed';
    }

    // advance / keep_open, OR a consequential "close" that becomes advance+confirm:
    // stamp reviewed_at (the grounded review happened), leave the loop active.
    await client.query(
      `UPDATE gtd_horizons SET reviewed_at = now(), updated_at = now()
        WHERE id = $1 AND user_id = $2`,
      [loopId, userId],
    );
    await client.query('COMMIT');
    return action === 'close' ? 'needs_confirm' : 'reviewed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error('[applyReconcile] failed — rolled back', { loopId, action, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Commit a consequential close AFTER the user has confirmed it (one-tap). Still
 * the worker/gateway is the sole writer — no second writer is introduced.
 * Atomic; user-scoped.
 */
export async function confirmReconcileClose(pool: Pool, userId: string, loopId: string): Promise<ReconcileResult> {
  const res = await pool.query(
    `UPDATE gtd_horizons
        SET status = 'completed', completed_at = now(), reviewed_at = now(), updated_at = now()
      WHERE id = $1 AND user_id = $2 AND horizon = 0 AND status = 'active'`,
    [loopId, userId],
  );
  return (res.rowCount ?? 0) > 0 ? 'closed' : 'not_found';
}

/**
 * Blast-radius circuit-breaker (D4, security HIGH-3). Given the count of closes
 * a single worker tick intends, decide whether to proceed or halt-and-surface.
 * Pure/deterministic so it's trivially testable and can't be prompt-bypassed.
 */
export const MAX_CLOSES_PER_TICK = 10;
export function withinCloseCap(closesThisTick: number): boolean {
  return closesThisTick <= MAX_CLOSES_PER_TICK;
}
