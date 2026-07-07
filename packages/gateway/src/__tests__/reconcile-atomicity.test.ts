import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { applyReconcile } from '../reconcile-gate.js';
import { listReconcileWork } from '../reconcile.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/**
 * DECISION-025 §7 acceptance — item C1: worker crash / atomicity → NO-DROP.
 *
 * The off-agent reconciliation worker can crash or time out mid-tick. That must
 * NEVER (a) leave a half-applied loop (stamped-but-unclosed OR closed-but-
 * unstamped), nor (b) drop a candidate so it's never re-offered. These tests
 * assert those two guarantees against the ALREADY-BUILT gate + selector:
 *   - reconcile-gate.ts  (applyReconcile) — one-UPDATE atomicity + rollback
 *   - reconcile.ts       (listReconcileWork) — at-least-once-until-reviewed
 * No production code is exercised via a change; these are pure observations.
 */

// ---------------------------------------------------------------------------
// Pool mock that records the FULL SQL of every statement (not just the verb),
// so we can assert a single UPDATE carries all of {status, completed_at,
// reviewed_at}. Same pg-mock shape as reconcile-gate.test.ts.
// ---------------------------------------------------------------------------
function makePool(stakes: string | null, opts: { failOnUpdate?: boolean } = {}) {
  const sqls: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      sqls.push(sql);
      if (params && params[1] !== undefined) expect(params[1]).toBe('u1'); // user-scoped
      if (sql.includes('SELECT stakes')) {
        return stakes === null ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ stakes }] };
      }
      if (opts.failOnUpdate && sql.trim().toUpperCase().startsWith('UPDATE')) {
        throw new Error('worker crash mid-UPDATE');
      }
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, client, sqls };
}

/** The single UPDATE statement issued during a tick (there is exactly one). */
function theUpdate(sqls: string[]): string {
  const updates = sqls.filter((s) => s.trim().toUpperCase().startsWith('UPDATE'));
  expect(updates.length, 'exactly one UPDATE per tick').toBe(1);
  return updates[0];
}

// ===========================================================================
// Property 1 — reviewed_at ↔ close ATOMICITY (one UPDATE carries everything).
// Verb/SQL-recording assertions: there is no interleaving in which a crash can
// land between "closed" and "stamped reviewed" because they are one statement.
// ===========================================================================
describe('C1.1 — reviewed_at ↔ close atomicity (single UPDATE)', () => {
  it('low-stakes close: status=completed + completed_at + reviewed_at in ONE UPDATE', async () => {
    const { pool, sqls } = makePool('low');
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('closed');

    const upd = theUpdate(sqls);
    // All three state changes live in the SAME statement — atomic by construction.
    expect(upd).toContain("status = 'completed'");
    expect(upd).toContain('completed_at = now()');
    expect(upd).toContain('reviewed_at = now()');
    // ...and it commits after that one write (no second UPDATE to race with).
    expect(sqls.map((s) => s.trim().split(/\s+/)[0].toUpperCase())).toEqual([
      'BEGIN',
      'SELECT',
      'UPDATE',
      'COMMIT',
    ]);
  });

  it('advance: ONLY reviewed_at advances (no status/completed_at), still one atomic UPDATE', async () => {
    for (const action of ['advance', 'keep_open'] as const) {
      const { pool, sqls } = makePool('low');
      const r = await applyReconcile(pool, 'u1', 'l1', action);
      expect(r).toBe('reviewed');

      const upd = theUpdate(sqls);
      expect(upd).toContain('reviewed_at = now()');
      expect(upd).not.toContain("status = 'completed'");
      expect(upd).not.toContain('completed_at');
    }
  });

  it('consequential close (downgraded to advance+confirm): reviewed_at only, one UPDATE, never closes', async () => {
    const { pool, sqls } = makePool('consequential');
    const r = await applyReconcile(pool, 'u1', 'l1', 'close');
    expect(r).toBe('needs_confirm');

    const upd = theUpdate(sqls);
    expect(upd).toContain('reviewed_at = now()');
    expect(upd).not.toContain("status = 'completed'"); // never auto-closed on a possibly-forged signal
  });
});

// ===========================================================================
// Property 2 — CRASH mid-tick ROLLS BACK (no partial write) + client released.
// If the UPDATE throws, the tx rolls back and rethrows; there is no COMMIT, so
// reviewed_at never advances, and the pooled client is always released.
// ===========================================================================
describe('C1.2 — crash mid-UPDATE rolls back, nothing half-applied', () => {
  it('UPDATE throws → ROLLBACK, rethrow, NO commit, client.release() still runs', async () => {
    const { pool, client, sqls } = makePool('low', { failOnUpdate: true });
    await expect(applyReconcile(pool, 'u1', 'l1', 'close')).rejects.toThrow('worker crash mid-UPDATE');

    const verbs = sqls.map((s) => s.trim().split(/\s+/)[0].toUpperCase());
    expect(verbs).toContain('ROLLBACK'); // transaction undone
    expect(verbs).not.toContain('COMMIT'); // reviewed_at advance NOT persisted
    expect(client.release).toHaveBeenCalled(); // pooled connection never leaked
  });

  it('advance crash also rolls back (reviewed_at does not advance)', async () => {
    const { pool, client, sqls } = makePool('low', { failOnUpdate: true });
    await expect(applyReconcile(pool, 'u1', 'l1', 'advance')).rejects.toThrow('worker crash mid-UPDATE');
    const verbs = sqls.map((s) => s.trim().split(/\s+/)[0].toUpperCase());
    expect(verbs).toContain('ROLLBACK');
    expect(verbs).not.toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });
});

// ===========================================================================
// Property 3 — AT-LEAST-ONCE-UNTIL-REVIEWED (no dropped candidate). Selector
// property driven through listReconcileWork with a mock pg (loops) + fake ES
// (inbound timestamps), mirroring reconcile.test.ts.
//   (a) tick crashed BEFORE the grounded reconcile ⇒ reviewed_at UNCHANGED,
//       inbound still newer ⇒ STILL a candidate next tick (retried, not lost).
//   (b) grounded reconcile advanced reviewed_at PAST the last inbound ⇒ drops.
// ===========================================================================
function makeSelectorPool(rows: unknown[]): Pool {
  return {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params[0]).toBe('u1'); // user-scoped
      return { rows };
    }),
  } as unknown as Pool;
}

function makeEs(lastByConv: Record<string, string>): Client {
  return {
    search: vi.fn(async () => ({
      aggregations: {
        by_conv: {
          buckets: Object.entries(lastByConv).map(([key, ts]) => ({ key, last: { value_as_string: ts } })),
        },
      },
    })),
  } as unknown as Client;
}

const T_CREATED = '2026-07-06T09:00:00Z';
const T_REVIEWED_BEFORE = '2026-07-06T10:00:00Z'; // reviewed_at from a PRIOR grounded tick
const T_INBOUND = '2026-07-06T11:00:00Z'; // the new inbound the crashed tick was meant to reconcile
const T_REVIEWED_AFTER = '2026-07-06T12:00:00Z'; // reviewed_at once the grounded reconcile lands

describe('C1.3 — at-least-once-until-reviewed (crashed tick is retried, not dropped)', () => {
  const loop = (reviewed_at: string | null) => ({
    id: 'l1',
    title: 'Moti payment',
    waiting_for: 'Moti',
    conversation_id: 'c1',
    stakes: 'low',
    due_date: null,
    reviewed_at,
    created_at: T_CREATED,
  });

  it('(a) crash BEFORE grounded reconcile: reviewed_at unchanged, inbound newer ⇒ STILL a candidate', async () => {
    // The worker crashed (Property 2 rolled the tx back), so reviewed_at is
    // still the pre-tick value and the inbound remains newer than it.
    const pool = makeSelectorPool([loop(T_REVIEWED_BEFORE)]);
    const es = makeEs({ c1: T_INBOUND });
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(1);
    expect(work.candidates[0].id).toBe('l1');
    expect(work.candidates[0].last_inbound_at).toBe(T_INBOUND);
  });

  it('(a′) crash on a never-reviewed loop: created_at is the floor, inbound newer ⇒ STILL a candidate', async () => {
    const pool = makeSelectorPool([loop(null)]); // never reviewed → compare against created_at
    const es = makeEs({ c1: T_INBOUND });
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(1);
  });

  it('(b) after grounded reconcile advances reviewed_at PAST the inbound ⇒ DROPS from candidates', async () => {
    const pool = makeSelectorPool([loop(T_REVIEWED_AFTER)]);
    const es = makeEs({ c1: T_INBOUND }); // inbound now older than reviewed_at
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(0);
    expect(work.candidates).toEqual([]);
  });

  it('convergence: same loop is a candidate before the review and NOT after — proving at-least-once, terminating', async () => {
    const es = makeEs({ c1: T_INBOUND });
    const before = await listReconcileWork(makeSelectorPool([loop(T_REVIEWED_BEFORE)]), es, 'u1');
    const after = await listReconcileWork(makeSelectorPool([loop(T_REVIEWED_AFTER)]), es, 'u1');
    expect(before.missed_close_count).toBe(1); // retried until reviewed
    expect(after.missed_close_count).toBe(0); // then settles to 0 (no infinite re-offer)
  });
});
