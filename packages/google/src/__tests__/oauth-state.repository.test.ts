import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOAuthStateRepository } from '../repositories/postgres/oauth-state.repository.js';

const USER_ID = 'user-oauth-state-1';
const SCOPES = ['calendar.readonly', 'gmail.send'];

interface StoredRow {
  state: string;
  user_id: string;
  scopes: string[];
  expires_at: Date;
}

/**
 * A stateful mock Pool that emulates just enough Postgres semantics for the
 * three queries the state repo issues (INSERT ... ON CONFLICT, DELETE ...
 * expires_at > now() RETURNING, DELETE ... expires_at <= now() RETURNING).
 * This lets us assert real found/consumed-once/expired/sweep behaviour.
 */
function makeMockPool(): { pool: Pool; rows: Map<string, StoredRow>; query: ReturnType<typeof vi.fn> } {
  const rows = new Map<string, StoredRow>();

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const now = Date.now();

    if (/^\s*INSERT INTO google_oauth_states/i.test(sql)) {
      const [state, user_id, scopesJson, expires_at] = params as [string, string, string, Date];
      rows.set(state, {
        state,
        user_id,
        scopes: JSON.parse(scopesJson) as string[],
        expires_at: expires_at as Date,
      });
      return { rows: [] };
    }

    if (/DELETE FROM google_oauth_states\s+WHERE state = \$1 AND expires_at > now\(\)/i.test(sql)) {
      const [state] = params as [string];
      const row = rows.get(state);
      if (row && row.expires_at.getTime() > now) {
        rows.delete(state);
        return { rows: [{ user_id: row.user_id, scopes: row.scopes }] };
      }
      return { rows: [] };
    }

    if (/DELETE FROM google_oauth_states WHERE expires_at <= now\(\)/i.test(sql)) {
      const removed: { state: string }[] = [];
      for (const [state, row] of rows) {
        if (row.expires_at.getTime() <= now) {
          rows.delete(state);
          removed.push({ state });
        }
      }
      return { rows: removed };
    }

    throw new Error(`Unexpected SQL: ${sql}`);
  });

  const pool = { query } as unknown as Pool;
  return { pool, rows, query };
}

describe('PostgresOAuthStateRepository', () => {
  it('putState persists a single-use state that takeState consumes exactly once', async () => {
    const { pool } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);

    await repo.putState('state-abc', USER_ID, SCOPES, 60 * 60 * 1000);

    // First take: found, returns userId + scopes
    const first = await repo.takeState('state-abc');
    expect(first).toEqual({ userId: USER_ID, scopes: SCOPES });

    // Second take: already consumed → null (single-use)
    const second = await repo.takeState('state-abc');
    expect(second).toBeNull();
  });

  it('putState stores scopes as a JSON string cast to jsonb', async () => {
    const { pool, query } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);

    await repo.putState('state-json', USER_ID, SCOPES, 60 * 60 * 1000);

    // Last call is the INSERT (putState sweeps first, then inserts).
    const insertCall = query.mock.calls.find(([sql]) => /INSERT INTO google_oauth_states/i.test(sql as string));
    expect(insertCall).toBeDefined();
    const params = insertCall![1] as unknown[];
    expect(params[0]).toBe('state-json');
    expect(params[1]).toBe(USER_ID);
    expect(params[2]).toBe(JSON.stringify(SCOPES));
    expect(params[3]).toBeInstanceOf(Date);
  });

  it('takeState returns null for an expired state', async () => {
    const { pool } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);

    // TTL already in the past → row is expired the moment it is written.
    await repo.putState('state-expired', USER_ID, SCOPES, -1000);

    const taken = await repo.takeState('state-expired');
    expect(taken).toBeNull();
  });

  it('takeState returns null for an unknown state', async () => {
    const { pool } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);

    expect(await repo.takeState('never-issued')).toBeNull();
  });

  it('sweepExpired deletes only past-expiry rows and reports the count', async () => {
    const { pool, rows } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);

    // Two live, one already-expired. Insert the live ones first so the
    // opportunistic sweep inside putState does not remove the expired one
    // before we assert on it.
    await repo.putState('live-1', USER_ID, SCOPES, 60 * 60 * 1000);
    await repo.putState('live-2', USER_ID, SCOPES, 60 * 60 * 1000);
    // Inject an expired row directly (bypassing putState's sweep).
    rows.set('dead-1', { state: 'dead-1', user_id: USER_ID, scopes: SCOPES, expires_at: new Date(Date.now() - 5000) });

    const removed = await repo.sweepExpired();
    expect(removed).toBe(1);
    expect(rows.has('dead-1')).toBe(false);
    expect(rows.has('live-1')).toBe(true);
    expect(rows.has('live-2')).toBe(true);
  });

  it('takeState issues an atomic DELETE ... RETURNING (single round-trip consume)', async () => {
    const { pool, query } = makeMockPool();
    const repo = new PostgresOAuthStateRepository(pool);
    await repo.putState('state-atomic', USER_ID, SCOPES, 60 * 60 * 1000);

    query.mockClear();
    await repo.takeState('state-atomic');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql] = query.mock.calls[0] as [string];
    expect(sql).toMatch(/DELETE FROM google_oauth_states/i);
    expect(sql).toMatch(/RETURNING/i);
  });
});
