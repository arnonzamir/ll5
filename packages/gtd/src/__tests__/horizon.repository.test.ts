import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PostgresHorizonRepository } from '../repositories/postgres/horizon.repository.js';
import { makeMockPool } from './_helpers.js';

const USER_A = 'user-a';
const USER_B = 'user-b';

/** Helper: extract the SQL + params from the Nth pool.query() call. */
function call(query: ReturnType<typeof vi.fn>, n: number): { sql: string; params: unknown[] } {
  const args = query.mock.calls[n] as [string, unknown[]];
  return { sql: args[0], params: args[1] };
}

describe('PostgresHorizonRepository.deleteAction', () => {
  it('returns true when an owned existing action is deleted (single DELETE ... RETURNING)', async () => {
    // FIFO queue: the (only correct) DELETE ... RETURNING returns the deleted row.
    // Any second query — as the buggy double-DELETE does — sees an empty result,
    // because the row is already gone.
    const { pool, query } = makeMockPool([[{ id: 'act-1' }]]);
    const repo = new PostgresHorizonRepository(pool);

    const result = await repo.deleteAction(USER_A, 'act-1');

    expect(result).toBe(true);
    // Exactly one DELETE statement should have run.
    expect(query).toHaveBeenCalledTimes(1);
    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/DELETE FROM gtd_horizons/);
    expect(sql).toMatch(/RETURNING id/);
    // user_id scoping (multi-tenancy, mandatory).
    expect(sql).toMatch(/WHERE.*user_id = \$\d/);
    expect(sql).toMatch(/horizon = 0/);
    expect(params).toEqual(['act-1', USER_A]);
  });

  it('returns false for a non-existent id', async () => {
    const { pool, query } = makeMockPool([]); // no rows -> nothing deleted
    const repo = new PostgresHorizonRepository(pool);

    const result = await repo.deleteAction(USER_A, 'missing');

    expect(result).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns false and leaves another user's action intact (cross-tenant)", async () => {
    // USER_B owns act-b. USER_A tries to delete it by id. The user_id scope in
    // the WHERE clause means the DELETE matches nothing -> empty result.
    const { pool, query } = makeMockPool([]); // scoped DELETE matches no rows
    const repo = new PostgresHorizonRepository(pool);

    const result = await repo.deleteAction(USER_A, 'act-b');

    expect(result).toBe(false);
    // Proves the scope: the userId, not the row owner, is bound into the query.
    const { sql, params } = call(query, 0);
    expect(sql).toMatch(/WHERE.*user_id = \$\d/);
    expect(params).toEqual(['act-b', USER_A]);
    // Sanity: only one (scoped) DELETE was attempted; nothing ran unscoped.
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('PostgresHorizonRepository.updateAction completed_at semantics', () => {
  const row = (over: Record<string, unknown> = {}) => [
    { id: 'act-1', user_id: USER_A, horizon: 0, status: 'completed', ...over },
  ];

  it('does NOT clear completed_at when status changes to on_hold (preserves history)', async () => {
    const { pool, query } = makeMockPool([row({ status: 'on_hold' })]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.updateAction(USER_A, 'act-1', { status: 'on_hold' });

    const { sql, params } = call(query, 0);
    expect(sql).not.toMatch(/completed_at = NULL/);
    // user_id scoping.
    expect(sql).toMatch(/WHERE.*user_id = \$\d/);
    expect(params).toContain(USER_A);
  });

  it('does NOT clear completed_at when status changes to dropped (preserves history)', async () => {
    const { pool, query } = makeMockPool([row({ status: 'dropped' })]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.updateAction(USER_A, 'act-1', { status: 'dropped' });

    const { sql } = call(query, 0);
    expect(sql).not.toMatch(/completed_at = NULL/);
  });

  it('does NOT clear completed_at on an unrelated field update with no status', async () => {
    const { pool, query } = makeMockPool([row()]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.updateAction(USER_A, 'act-1', { title: 'renamed' });

    const { sql } = call(query, 0);
    expect(sql).not.toMatch(/completed_at = NULL/);
  });

  it('clears completed_at ONLY on an explicit transition back to active', async () => {
    const { pool, query } = makeMockPool([row({ status: 'active' })]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.updateAction(USER_A, 'act-1', { status: 'active' });

    const { sql } = call(query, 0);
    expect(sql).toMatch(/completed_at = NULL/);
  });

  it('sets completed_at when status changes to completed', async () => {
    const { pool, query } = makeMockPool([row({ status: 'completed' })]);
    const repo = new PostgresHorizonRepository(pool);

    await repo.updateAction(USER_A, 'act-1', { status: 'completed' });

    const { sql } = call(query, 0);
    expect(sql).toMatch(/completed_at = now\(\)/);
    expect(sql).not.toMatch(/completed_at = NULL/);
  });
});
