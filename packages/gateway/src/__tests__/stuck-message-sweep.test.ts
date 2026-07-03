import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';

import { StuckMessageSweep } from '../scheduler/stuck-message-sweep.js';

interface QueryCall { sql: string; params: unknown[] }

function poolCapture(results: Array<{ rowCount: number; rows: Array<Record<string, unknown>> }>): {
  pool: Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let i = 0;
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return results[Math.min(i++, results.length - 1)] ?? { rowCount: 0, rows: [] };
  });
  return { pool: { query } as unknown as Pool, calls };
}

const mk = (pool: Pool) =>
  new StuckMessageSweep(pool, {
    intervalMinutes: 10,
    stuckAfterMinutes: 30,
    renotifyAfterMinutes: 3,
    maxRenotifies: 3,
    channels: ['system'],
    userId: 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
  });

const tick = (s: StuckMessageSweep) => (s as unknown as { tick: () => Promise<void> }).tick();

describe('StuckMessageSweep (lost-NOTIFY recovery, 2026-07-03)', () => {
  it('pass A re-notifies pending rows via pg_notify with the insert-trigger payload shape', async () => {
    const { pool, calls } = poolCapture([
      { rowCount: 2, rows: [{ id: 'a', attempt: 1 }, { id: 'b', attempt: 2 }] },
      { rowCount: 0, rows: [] },
    ]);
    await tick(mk(pool));

    expect(calls).toHaveLength(2);
    const renotify = calls[0];
    // Only never-picked-up rows: pending, attempt counter below the cap.
    expect(renotify.sql).toContain("status = 'pending'");
    expect(renotify.sql).toContain('re_notify_count');
    expect(renotify.sql).toContain('pg_notify');
    expect(renotify.sql).toContain("'new_message'");
    // Params: channels, renotify-after, max, userId.
    expect(renotify.params).toEqual([
      ['system'], 3, 3, 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
    ]);
    // Re-notify must NOT flip status — delivery stays owned by the channel.
    expect(renotify.sql).not.toContain("SET status = 'delivered'");
  });

  it('pass A never re-notifies processing rows (the channel already received them)', async () => {
    const { pool, calls } = poolCapture([{ rowCount: 0, rows: [] }]);
    await tick(mk(pool));
    expect(calls[0].sql).toContain("status = 'pending'");
    expect(calls[0].sql).not.toContain('processing');
  });

  it('pass B flips processing rows unconditionally but pending rows only after re-notifies are exhausted', async () => {
    const { pool, calls } = poolCapture([
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ id: 'c', re_notify_count: null }] },
    ]);
    await tick(mk(pool));
    const flip = calls[1];
    expect(flip.sql).toContain("SET status = 'delivered'");
    expect(flip.sql).toContain("status = 'processing'");
    // The pending branch is gated on the exhausted counter — a fresh pending
    // row (the pre-2026-07-03 silent-mask case) can no longer be blind-flipped.
    expect(flip.sql).toMatch(/status = 'pending' AND COALESCE\(\(metadata->>'re_notify_count'\)::int, 0\) >= \$3/);
    expect(flip.params).toEqual([
      ['system'], 30, 3, 'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
    ]);
  });

  it('a pass-A failure does not prevent pass B from running', async () => {
    const calls: QueryCall[] = [];
    let first = true;
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      if (first) {
        first = false;
        throw new Error('renotify boom');
      }
      return { rowCount: 0, rows: [] };
    });
    await tick(mk({ query } as unknown as Pool));
    expect(calls).toHaveLength(2);
    expect(calls[1].sql).toContain("SET status = 'delivered'");
  });

  it('scopes both passes to the configured user', async () => {
    const { pool, calls } = poolCapture([{ rowCount: 0, rows: [] }]);
    await tick(mk(pool));
    for (const c of calls) {
      expect(c.sql).toContain('AND user_id = $4::uuid');
    }
  });
});
