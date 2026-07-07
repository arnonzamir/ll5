import type { Pool } from 'pg';
import { logger } from './utils/logger.js';

/**
 * Open-loop register (DECISION-025 D2) — a READ-MODEL, not a new store.
 *
 * Composes the user's currently-in-flight loops from existing GTD data (the
 * gateway reads `gtd_horizons` directly, same as gtd-surfaces/today/tray):
 *   - waiting-fors  — horizon-0 actions awaiting a signal (the primary
 *                     reconciliation targets)
 *   - next-actions  — other active horizon-0 actions (context)
 *   - projects      — active horizon-1 projects/goals (e.g. the green-belt plan)
 *
 * STRICTLY `user_id`-scoped. BEST-EFFORT: each source is independently
 * try/caught so a partial result is returned rather than failing the caller
 * (the batch payload / worker must never break on a slow or erroring source).
 * No new persistence — the loops already live in GTD; this is the query that
 * unifies them.
 */

export interface WaitingForLoop {
  id: string;
  title: string;
  waiting_for: string | null;
  due_date: string | null;
  created_at: string;
}

export interface NextActionLoop {
  id: string;
  title: string;
  due_date: string | null;
}

export interface ProjectLoop {
  id: string;
  title: string;
  due_date: string | null;
}

export interface OpenLoops {
  waiting_fors: WaitingForLoop[];
  next_actions: NextActionLoop[];
  projects: ProjectLoop[];
}

export async function getOpenLoops(pool: Pool, userId: string): Promise<OpenLoops> {
  const waiting_fors = await pool
    .query<WaitingForLoop>(
      `SELECT id, title, waiting_for, due_date, created_at
         FROM gtd_horizons
        WHERE user_id = $1 AND horizon = 0 AND status = 'active'
          AND (list_type = 'waiting' OR waiting_for IS NOT NULL)
        ORDER BY due_date ASC NULLS LAST, created_at DESC`,
      [userId],
    )
    .then((r) => r.rows)
    .catch((err) => {
      logger.warn('[getOpenLoops] waiting_fors query failed', { error: String(err) });
      return [] as WaitingForLoop[];
    });

  const next_actions = await pool
    .query<NextActionLoop>(
      `SELECT id, title, due_date
         FROM gtd_horizons
        WHERE user_id = $1 AND horizon = 0 AND status = 'active'
          AND (list_type IS NULL OR list_type NOT IN ('shopping', 'waiting'))
          AND waiting_for IS NULL
        ORDER BY due_date ASC NULLS LAST, created_at DESC`,
      [userId],
    )
    .then((r) => r.rows)
    .catch((err) => {
      logger.warn('[getOpenLoops] next_actions query failed', { error: String(err) });
      return [] as NextActionLoop[];
    });

  const projects = await pool
    .query<ProjectLoop>(
      `SELECT id, title, due_date
         FROM gtd_horizons
        WHERE user_id = $1 AND horizon = 1 AND status = 'active'
        ORDER BY due_date ASC NULLS LAST, created_at DESC`,
      [userId],
    )
    .then((r) => r.rows)
    .catch((err) => {
      logger.warn('[getOpenLoops] projects query failed', { error: String(err) });
      return [] as ProjectLoop[];
    });

  return { waiting_fors, next_actions, projects };
}
