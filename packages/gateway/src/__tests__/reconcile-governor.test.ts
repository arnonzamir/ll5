import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../utils/scheduler-health.js', () => ({
  withSchedulerHealth: (_name: string, fn: () => Promise<void>) => fn(),
}));

import { ReconcileGovernorScheduler, type ReconcileMetricsDoc } from '../scheduler/reconcile-governor.js';

const T0 = '2026-07-06T10:00:00Z';
const T1 = '2026-07-06T11:00:00Z'; // newer inbound → makes a loop a candidate

type Loop = {
  id: string; conversation_id: string;
  reviewed_at?: string | null; created_at?: string;
};

/**
 * Fake pg pool that routes by SQL text:
 *  - the selector's "status = 'active'" loops query → `activeLoops`
 *  - the governor's "status = 'completed'" closed-loops query → `closedLoops`
 * Every call is asserted to be user-scoped ($1 === userId).
 */
function makePool(opts: {
  activeLoops?: Loop[];
  closedLoops?: Array<{ id: string; conversation_id: string }>;
  failClosed?: boolean;
  userId?: string;
}): Pool {
  const userId = opts.userId ?? 'u1';
  return {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      expect(params[0]).toBe(userId); // tenant scope on EVERY pg query
      if (/status = 'completed'/.test(sql)) {
        if (opts.failClosed) throw new Error('pg boom');
        return { rows: opts.closedLoops ?? [] };
      }
      // selector's active-loops query
      return {
        rows: (opts.activeLoops ?? []).map((l) => ({
          id: l.id, title: 't', waiting_for: null, conversation_id: l.conversation_id,
          stakes: 'low', due_date: null,
          reviewed_at: l.reviewed_at ?? T0, created_at: l.created_at ?? T0,
        })),
      };
    }),
  } as unknown as Pool;
}

/**
 * Fake ES client routing by index:
 *  - ll5_awareness_messages (selector inbound agg) → buckets from `lastByConv`
 *  - ll5_audit_log (grounding ledger) → hits with JSON args carrying conversation_id
 *  - .index() captures the written doc
 * Asserts user scoping on every search's filter.
 */
function makeEs(opts: {
  lastByConv?: Record<string, string>;
  groundedConvIds?: string[];
  failGrounding?: boolean;
  failIndex?: boolean;
  userId?: string;
}): { es: Client; written: ReconcileMetricsDoc[] } {
  const userId = opts.userId ?? 'u1';
  const written: ReconcileMetricsDoc[] = [];
  const es = {
    search: vi.fn(async (req: any) => {
      const filters = req.query?.bool?.filter ?? [];
      const hasUserScope = filters.some((f: any) => f?.term?.user_id === userId);
      expect(hasUserScope).toBe(true); // tenant scope on EVERY es query
      if (req.index === 'll5_audit_log') {
        if (opts.failGrounding) throw new Error('es grounding boom');
        return {
          hits: {
            hits: (opts.groundedConvIds ?? []).map((cid) => ({
              _source: { args: JSON.stringify({ conversation_id: cid, sender: 'x' }) },
            })),
          },
        };
      }
      // selector's awareness inbound aggregation
      return {
        aggregations: {
          by_conv: {
            buckets: Object.entries(opts.lastByConv ?? {}).map(([key, ts]) => ({
              key, last: { value_as_string: ts },
            })),
          },
        },
      };
    }),
    index: vi.fn(async (req: any) => {
      if (opts.failIndex) throw new Error('es index boom');
      written.push(req.document as ReconcileMetricsDoc);
      return { result: 'created' };
    }),
  } as unknown as Client;
  return { es, written };
}

const tick = (m: ReconcileGovernorScheduler) => (m as unknown as { tick: () => Promise<void> }).tick();

describe('ReconcileGovernorScheduler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('wires missed_close_count + candidate_count from listReconcileWork', async () => {
    const pool = makePool({
      activeLoops: [
        { id: 'l1', conversation_id: 'c1' },
        { id: 'l2', conversation_id: 'c2' },
      ],
    });
    // both threads have an inbound newer than reviewed_at → both are candidates
    const { es, written } = makeEs({ lastByConv: { c1: T1, c2: T1 } });
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' }));

    expect(written).toHaveLength(1);
    expect(written[0].missed_close_count).toBe(2);
    expect(written[0].candidate_count).toBe(2);
  });

  it('coverage = grounded candidates / candidates', async () => {
    const pool = makePool({
      activeLoops: [
        { id: 'l1', conversation_id: 'c1' },
        { id: 'l2', conversation_id: 'c2' },
      ],
    });
    // 2 candidates; only c1 got a query_im_messages grounding call → coverage 0.5
    const { es, written } = makeEs({ lastByConv: { c1: T1, c2: T1 }, groundedConvIds: ['c1'] });
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' }));

    expect(written[0].reconciliation_coverage).toBe(0.5);
  });

  it('coverage is null (no NaN / divide-by-zero) when there are 0 candidates', async () => {
    const pool = makePool({ activeLoops: [] }); // no active loops → 0 candidates
    const { es, written } = makeEs({});
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' }));

    expect(written[0].candidate_count).toBe(0);
    expect(written[0].reconciliation_coverage).toBeNull();
    expect(Number.isNaN(written[0].reconciliation_coverage as unknown as number)).toBe(false);
  });

  it('wrong_close_count: grounded close is NOT counted, zero-grounding close IS counted', async () => {
    const pool = makePool({
      activeLoops: [],
      closedLoops: [
        { id: 'w1', conversation_id: 'cg' }, // grounded → not wrong
        { id: 'w2', conversation_id: 'cn' }, // no grounding → wrong close
      ],
    });
    const { es, written } = makeEs({ groundedConvIds: ['cg'] });
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' }));

    expect(written[0].wrong_close_count).toBe(1);
  });

  it('emits ONLY counts/ids/timestamp — no message body or free text leaks (security F5)', async () => {
    const pool = makePool({
      activeLoops: [{ id: 'l1', conversation_id: 'c1' }],
      closedLoops: [{ id: 'w1', conversation_id: 'cn' }],
    });
    const { es, written } = makeEs({ lastByConv: { c1: T1 }, groundedConvIds: [] });
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' }));

    const doc = written[0];
    const allowed = new Set([
      'user_id', 'timestamp', 'missed_close_count', 'wrong_close_count',
      'reconciliation_coverage', 'candidate_count', 'window_minutes',
    ]);
    for (const key of Object.keys(doc)) expect(allowed.has(key)).toBe(true);
    // Every value is a count/id/enum/timestamp — never free text like a title/body/message.
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toMatch(/message|body|title|text|content|waiting_for|summary/i);
  });

  it('best-effort: a throwing PG closed-loops query does not throw out of tick', async () => {
    const pool = makePool({ activeLoops: [{ id: 'l1', conversation_id: 'c1' }], failClosed: true });
    const { es, written } = makeEs({ lastByConv: { c1: T1 } });
    await expect(
      tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' })),
    ).resolves.toBeUndefined();
    // Degrades gracefully: still writes a doc, wrong_close_count degraded to 0.
    expect(written[0]?.wrong_close_count).toBe(0);
  });

  it('best-effort: a throwing ES grounding query does not throw out of tick', async () => {
    const pool = makePool({ activeLoops: [{ id: 'l1', conversation_id: 'c1' }] });
    const { es, written } = makeEs({ lastByConv: { c1: T1 }, failGrounding: true });
    await expect(
      tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' })),
    ).resolves.toBeUndefined();
    // grounding empty → coverage 0 (0 grounded / 1 candidate), still writes.
    expect(written[0].reconciliation_coverage).toBe(0);
  });

  it('best-effort: a throwing ES index write does not throw out of tick', async () => {
    const pool = makePool({ activeLoops: [] });
    const { es } = makeEs({ failIndex: true });
    await expect(
      tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u1' })),
    ).resolves.toBeUndefined();
  });

  it('cross-tenant: every PG and ES query carries user_id; another tenant never contributes', async () => {
    // Tenant u2's pool/es. The makePool/makeEs assertions fail if any query is not
    // scoped to u2. A u1 loop/grounding row would never reach these (scoped) queries.
    const pool = makePool({
      userId: 'u2',
      activeLoops: [{ id: 'l1', conversation_id: 'c1' }],
      closedLoops: [{ id: 'w1', conversation_id: 'cn' }],
    });
    const { es, written } = makeEs({ userId: 'u2', lastByConv: { c1: T1 }, groundedConvIds: ['c1'] });
    await tick(new ReconcileGovernorScheduler(pool, es, { intervalMinutes: 15, userId: 'u2' }));

    expect(written[0].user_id).toBe('u2');
    // Assertions inside makePool/makeEs already enforced $1 === 'u2' and es filter user_id === 'u2'.
    // Confirm the queries actually ran (so the scope checks executed).
    expect((pool.query as any)).toHaveBeenCalled();
    expect((es.search as any)).toHaveBeenCalled();
  });
});
