import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { ChatSearchIndexer } from '../scheduler/chat-search-indexer.js';

/**
 * Backfill pagination correctness (review bug 2026-05-29, LOW).
 *
 * The backfill walks chat_messages in pages ordered by created_at DESC. A
 * strict single-column cursor (`WHERE created_at < $1`, cursor = last row's
 * created_at) silently drops every row that shares the boundary created_at
 * with the last row of the previous page. The fix is a stable tuple cursor
 * `(created_at, id)`.
 *
 * This test proves:
 *   (a) the generated paging SQL uses a tuple cursor `(created_at, id)`, and
 *   (b) a two-page walk over rows whose created_at collides across the page
 *       boundary returns EVERY row (none skipped).
 *
 * Strategy: a mock pg.Pool that interprets the cursor params the production
 * code actually sends. A correct tuple cursor sends two params and the mock
 * filters with `(created_at, id) < (c, i)`; a buggy single-column cursor
 * sends one param and the mock filters with `created_at < c` — which drops
 * the boundary-sharing rows, failing assertion (b).
 */

const USER_ID = 'user-backfill-1';

type Row = {
  id: string;
  user_id: string;
  conversation_id: string;
  channel: string;
  direction: string;
  role: string;
  content: string | null;
  reaction: string | null;
  reply_to_id: string | null;
  display_compact: boolean;
  created_at: string;
};

function mkRow(id: string, created_at: string): Row {
  return {
    id,
    user_id: USER_ID,
    conversation_id: 'conv-1',
    channel: 'web',
    direction: 'inbound',
    role: 'user',
    content: `msg ${id}`,
    reaction: null,
    reply_to_id: null,
    display_compact: false,
    created_at,
  };
}

/**
 * Build a dataset that forces a genuine multi-page walk through the real
 * backfill loop (which only continues while a page comes back full), with a
 * shared created_at straddling the page boundary.
 *
 * The production page size is read off the `LIMIT n` in the SQL so this test
 * doesn't hardcode (or break against) the PAGE constant. We make the first
 * page exactly `PAGE` rows, then plant additional rows that share the LAST
 * row's created_at (`T`). A single-column `created_at < $1` cursor skips
 * every one of those boundary-sharing rows; a `(created_at, id)` tuple cursor
 * keeps them.
 *
 * Ordered DESC by (created_at, id):
 *   newest .. (PAGE-1 rows @ distinct, later timestamps) ..  ← page 1
 *   boundary_keep_2 @ T   (id sorts BEFORE the page-1 tail row's id)  ← page 2
 *   boundary_keep_1 @ T
 *   (the page-1 tail row is also @ T)
 *   oldest @ T-1
 */
const T = '2026-05-29T12:00:00.000Z';

// Distinct, strictly-decreasing timestamps for the bulk of page 1, all AFTER T.
function buildDataset(pageSize: number): Row[] {
  const rows: Row[] = [];
  // pageSize-1 rows with unique later timestamps (ids p0000.. sort high → fill page 1 head)
  for (let n = 0; n < pageSize - 1; n++) {
    const secs = String(10 + n).padStart(2, '0');
    rows.push(mkRow(`p${String(n).padStart(4, '0')}`, `2026-05-29T13:00:${secs}.000Z`));
  }
  // The page-1 tail row sits AT the boundary timestamp T, with a HIGH id so it
  // sorts last within the T-cluster under DESC(created_at,id) → it is the last
  // row of page 1.
  rows.push(mkRow('zzz_tail', T));
  // Rows that share T but with LOWER ids → must appear on page 2. The buggy
  // `created_at < T` cursor drops these entirely.
  rows.push(mkRow('aaa_keep1', T));
  rows.push(mkRow('aaa_keep2', T));
  // One strictly-older row to confirm the walk reaches the true tail.
  rows.push(mkRow('oldest', '2026-05-29T11:59:59.000Z'));
  return rows;
}

function cmpDesc(a: Row, b: Row): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

function expectedIds(pageSize: number): string[] {
  return buildDataset(pageSize)
    .map((r) => r.id)
    .sort();
}

function parseLimit(sql: string): number {
  const m = sql.match(/LIMIT\s+(\d+)/i);
  return m ? Number(m[1]) : 1000;
}

function makeMockPool(captured: { sqls: string[]; params: unknown[][] }): Pool {
  let sorted: Row[] | null = null;
  return {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      captured.sqls.push(sql);
      captured.params.push(params ?? []);

      // conversations backfill query (no created_at paging) → empty
      if (/FROM chat_conversations/.test(sql)) {
        return { rows: [] };
      }

      const limit = parseLimit(sql);
      if (sorted == null) sorted = [...buildDataset(limit)].sort(cmpDesc);

      let rows = sorted;
      const p = params ?? [];
      if (p.length >= 2) {
        // tuple cursor: (created_at, id) < (c, i)
        const [c, i] = p as [string, string];
        rows = sorted.filter(
          (r) => r.created_at < c || (r.created_at === c && r.id < i),
        );
      } else if (p.length === 1) {
        // single-column cursor: created_at < c  (the buggy path)
        const [c] = p as [string];
        rows = sorted.filter((r) => r.created_at < c);
      }
      return { rows: rows.slice(0, limit) };
    }),
  } as unknown as Pool;
}

function makeMockEs(indexedIds: Set<string>): Client {
  return {
    indices: {
      exists: vi.fn().mockResolvedValue(true),
      create: vi.fn().mockResolvedValue({}),
    },
    bulk: vi.fn(async ({ operations }: { operations: unknown[] }) => {
      for (let k = 0; k < operations.length; k += 2) {
        const action = operations[k] as { index: { _id: string } };
        indexedIds.add(action.index._id);
      }
      return { errors: false, items: [] };
    }),
    index: vi.fn().mockResolvedValue({ result: 'created' }),
  } as unknown as Client;
}

describe('ChatSearchIndexer.backfill — tuple cursor pagination', () => {
  it('uses a (created_at, id) tuple cursor in the paging SQL', async () => {
    const captured = { sqls: [] as string[], params: [] as unknown[][] };
    const indexed = new Set<string>();
    const indexer = new ChatSearchIndexer(
      makeMockPool(captured),
      makeMockEs(indexed),
      'postgres://test',
    );

    await indexer.backfill();

    // At least one page query carried a cursor (params length >= 1).
    const cursoredSql = captured.sqls.find((sql, idx) => captured.params[idx].length > 0);
    expect(cursoredSql, 'expected a paged query that carries a cursor').toBeDefined();
    // The cursor must be a stable tuple over (created_at, id), not created_at alone.
    expect(cursoredSql).toMatch(/\(\s*created_at\s*,\s*id\s*\)\s*<\s*\(\s*\$\d+\s*,\s*\$\d+\s*\)/);
    expect(cursoredSql).toMatch(/ORDER BY\s+created_at\s+DESC\s*,\s*id\s+DESC/i);

    // Cursor params must carry both created_at AND id.
    const cursoredParams = captured.params.find((p) => p.length > 0)!;
    expect(cursoredParams.length).toBeGreaterThanOrEqual(2);
  });

  it('does not skip rows that share the boundary created_at across pages', async () => {
    const captured = { sqls: [] as string[], params: [] as unknown[][] };
    const indexed = new Set<string>();
    const indexer = new ChatSearchIndexer(
      makeMockPool(captured),
      makeMockEs(indexed),
      'postgres://test',
    );

    await indexer.backfill();

    // Derive the page size the production code actually used from its SQL.
    const pageSql = captured.sqls.find((s) => /FROM chat_messages/.test(s))!;
    const pageSize = parseLimit(pageSql);

    // Every message row must reach ES — none dropped at the duplicate-T boundary.
    // The buggy single-column cursor drops aaa_keep1/aaa_keep2 (they share T
    // with the page-1 tail row zzz_tail).
    expect([...indexed].sort()).toEqual(expectedIds(pageSize));
  });
});
