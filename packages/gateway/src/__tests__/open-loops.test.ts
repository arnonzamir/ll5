import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { getOpenLoops } from '../open-loops.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A pool whose query() routes by which SQL fragment it sees. */
function makePool(handlers: { waiting?: unknown; next?: unknown; projects?: unknown; fail?: 'waiting' | 'next' | 'projects' }): Pool {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    // every query MUST be user-scoped
    expect(params[0]).toBe('u1');
    const kind = sql.includes("horizon = 1")
      ? 'projects'
      : sql.includes("list_type = 'waiting' OR waiting_for IS NOT NULL")
        ? 'waiting'
        : 'next';
    if (handlers.fail === kind) throw new Error(`boom:${kind}`);
    const rows =
      kind === 'projects' ? handlers.projects : kind === 'waiting' ? handlers.waiting : handlers.next;
    return { rows: rows ?? [] };
  });
  return { query } as unknown as Pool;
}

describe('getOpenLoops', () => {
  it('composes the three sources, all user-scoped', async () => {
    const pool = makePool({
      waiting: [{ id: 'w1', title: 'Moti payment', waiting_for: 'Moti', due_date: null, created_at: 't' }],
      next: [{ id: 'n1', title: 'Book flights', due_date: null }],
      projects: [{ id: 'p1', title: 'Green belt', due_date: '2026-07-30' }],
    });
    const loops = await getOpenLoops(pool, 'u1');
    expect(loops.waiting_fors).toHaveLength(1);
    expect(loops.waiting_fors[0].waiting_for).toBe('Moti');
    expect(loops.next_actions[0].id).toBe('n1');
    expect(loops.projects[0].title).toBe('Green belt');
  });

  it('is best-effort — a failing source degrades to [] and does not throw', async () => {
    const pool = makePool({
      waiting: [{ id: 'w1', title: 'x', waiting_for: null, due_date: null, created_at: 't' }],
      projects: [{ id: 'p1', title: 'p', due_date: null }],
      fail: 'next', // next_actions query throws
    });
    const loops = await getOpenLoops(pool, 'u1');
    expect(loops.waiting_fors).toHaveLength(1); // survived
    expect(loops.next_actions).toEqual([]); // degraded, not thrown
    expect(loops.projects).toHaveLength(1); // survived
  });

  it('returns empty arrays for a user with no loops', async () => {
    const pool = makePool({});
    const loops = await getOpenLoops(pool, 'u1');
    expect(loops).toEqual({ waiting_fors: [], next_actions: [], projects: [] });
  });
});
