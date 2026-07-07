import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { applyReconcile, confirmReconcileClose, withinCloseCap, MAX_CLOSES_PER_TICK } from '../reconcile-gate.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Mock a pooled client. `stakes` null → loop not found. Records the SQL verbs. */
function makePool(stakes: string | null, opts: { failOnUpdate?: boolean } = {}) {
  const calls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      const verb = sql.trim().split(/\s+/)[0].toUpperCase();
      calls.push(sql.includes('SELECT stakes') ? 'SELECT' : sql.includes("status = 'completed'") ? 'CLOSE' : sql.includes('SET reviewed_at = now()') && !sql.includes('completed') ? 'STAMP' : verb);
      if (params && params[1] !== undefined) expect(params[1]).toBe('u1'); // user-scoped
      if (sql.includes('SELECT stakes')) {
        return stakes === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ stakes }] };
      }
      if (opts.failOnUpdate && (sql.includes("status = 'completed'") || sql.includes('SET reviewed_at'))) {
        throw new Error('update boom');
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, calls };
}

describe('applyReconcile — stakes routing + atomicity', () => {
  it('low-stakes close → CLOSED, in one transaction (BEGIN/CLOSE/COMMIT)', async () => {
    const { pool, calls } = makePool('low');
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('closed');
    expect(calls).toEqual(['BEGIN', 'SELECT', 'CLOSE', 'COMMIT']);
  });

  it('CONSEQUENTIAL close → needs_confirm, NOT closed (stamps reviewed only)', async () => {
    const { pool, calls } = makePool('consequential');
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('needs_confirm');
    expect(calls).toContain('STAMP'); // reviewed stamped
    expect(calls).not.toContain('CLOSE'); // never auto-closed
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('consequential close raises pending_confirm in the SAME stamp UPDATE (atomic surface flag)', async () => {
    const sqls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        sqls.push(sql);
        if (sql.includes('SELECT stakes')) return { rowCount: 1, rows: [{ stakes: 'consequential' }] };
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('needs_confirm');
    const stamp = sqls.find((s) => s.includes('reviewed_at = now()') && !s.includes("'completed'"));
    expect(stamp).toContain('pending_confirm = true');
  });

  it('advance/keep_open never raise pending_confirm', async () => {
    for (const action of ['advance', 'keep_open'] as const) {
      const sqls: string[] = [];
      const client = {
        query: vi.fn(async (sql: string) => {
          sqls.push(sql);
          if (sql.includes('SELECT stakes')) return { rowCount: 1, rows: [{ stakes: 'low' }] };
          return { rowCount: 1, rows: [] };
        }),
        release: vi.fn(),
      };
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      expect(await applyReconcile(pool, 'u1', 'l1', action)).toBe('reviewed');
      const stamp = sqls.find((s) => s.includes('reviewed_at = now()') && !s.includes("'completed'"));
      expect(stamp).not.toContain('pending_confirm');
    }
  });

  it('FAIL-SAFE: any non-`low` stakes value on close → needs_confirm, never CLOSE', async () => {
    // The gate auto-closes ONLY on the exact value 'low'. An unexpected tier,
    // wrong casing, or stray whitespace must be treated as consequential — never
    // an autonomous close on a possibly forged signal.
    for (const stakes of ['medium', 'high', 'Low', 'low ', 'critical', '']) {
      const { pool, calls } = makePool(stakes);
      const r = await applyReconcile(pool, 'u1', 'l1', 'close');
      expect(r, `stakes="${stakes}" must NOT auto-close`).toBe('needs_confirm');
      expect(calls).not.toContain('CLOSE');
      expect(calls).toContain('STAMP');
    }
  });

  it('advance/keep_open → reviewed (stamp only, stays active)', async () => {
    for (const action of ['advance', 'keep_open'] as const) {
      const { pool, calls } = makePool('low');
      const r = await applyReconcile(pool, 'u1', 'l1', action);
      expect(r).toBe('reviewed');
      expect(calls).toContain('STAMP');
      expect(calls).not.toContain('CLOSE');
    }
  });

  it('missing/inactive loop → not_found, transaction rolled back', async () => {
    const { pool, client } = makePool(null);
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('not_found');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('an update failure ROLLS BACK and rethrows (no partial write)', async () => {
    const { pool, client } = makePool('low', { failOnUpdate: true });
    await expect(applyReconcile(pool, 'u1', 'l1', 'close')).rejects.toThrow('update boom');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});

describe('confirmReconcileClose', () => {
  it('closes an active loop after user confirm (user-scoped)', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params[1]).toBe('u1');
      return { rowCount: 1 };
    });
    const pool = { query } as unknown as Pool;
    expect(await confirmReconcileClose(pool, 'u1', 'l1')).toBe('closed');
  });
  it('not_found when nothing matched', async () => {
    const pool = { query: vi.fn(async () => ({ rowCount: 0 })) } as unknown as Pool;
    expect(await confirmReconcileClose(pool, 'u1', 'l1')).toBe('not_found');
  });
});

describe('withinCloseCap — circuit-breaker', () => {
  it('permits up to the cap, halts beyond it', () => {
    expect(withinCloseCap(MAX_CLOSES_PER_TICK)).toBe(true);
    expect(withinCloseCap(MAX_CLOSES_PER_TICK + 1)).toBe(false);
  });
});
