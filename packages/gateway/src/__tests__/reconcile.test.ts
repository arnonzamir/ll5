import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { listReconcileWork } from '../reconcile.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makePool(rows: unknown[], opts: { fail?: boolean } = {}): Pool {
  return {
    query: vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params[0]).toBe('u1'); // user-scoped
      if (opts.fail) throw new Error('boom');
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

const T0 = '2026-07-06T10:00:00Z';
const T1 = '2026-07-06T11:00:00Z'; // newer inbound
const T2 = '2026-07-06T12:00:00Z'; // even newer

describe('listReconcileWork', () => {
  it('flags a loop whose linked conversation has an inbound newer than reviewed_at', async () => {
    const pool = makePool([
      { id: 'l1', title: 'Moti payment', waiting_for: 'Moti', conversation_id: 'c1', stakes: 'consequential', due_date: null, reviewed_at: T0, created_at: T0 },
    ]);
    const es = makeEs({ c1: T1 }); // inbound after reviewed_at
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(1);
    expect(work.candidates[0].id).toBe('l1');
    expect(work.candidates[0].last_inbound_at).toBe(T1);
  });

  it('does NOT flag a loop reviewed AFTER the last inbound (settles to 0)', async () => {
    const pool = makePool([
      { id: 'l1', title: 'x', waiting_for: null, conversation_id: 'c1', stakes: 'low', due_date: null, reviewed_at: T2, created_at: T0 },
    ]);
    const es = makeEs({ c1: T1 }); // inbound is OLDER than reviewed_at
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(0);
  });

  it('uses created_at when never reviewed', async () => {
    const pool = makePool([
      { id: 'l1', title: 'x', waiting_for: null, conversation_id: 'c1', stakes: 'low', due_date: null, reviewed_at: null, created_at: T0 },
    ]);
    const es = makeEs({ c1: T1 });
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(1);
  });

  it('ignores a loop whose conversation has no inbound', async () => {
    const pool = makePool([
      { id: 'l1', title: 'x', waiting_for: null, conversation_id: 'c1', stakes: 'low', due_date: null, reviewed_at: null, created_at: T0 },
    ]);
    const es = makeEs({}); // no inbound at all
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work.missed_close_count).toBe(0);
  });

  it('short-circuits with no loops (no ES call)', async () => {
    const pool = makePool([]);
    const es = makeEs({ c1: T1 });
    const work = await listReconcileWork(pool, es, 'u1');
    expect(work).toEqual({ candidates: [], missed_close_count: 0 });
    expect(es.search).not.toHaveBeenCalled();
  });

  it('best-effort: a failing loops query degrades to empty, no throw', async () => {
    const pool = makePool([], { fail: true });
    const es = makeEs({});
    await expect(listReconcileWork(pool, es, 'u1')).resolves.toEqual({ candidates: [], missed_close_count: 0 });
  });
});
