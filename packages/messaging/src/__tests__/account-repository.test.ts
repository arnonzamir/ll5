import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresAccountRepository } from '../repositories/postgres/account.repository.js';

const USER_ID = 'user-uuid-1';
const ACCOUNT_ID = 'account-uuid-9';
const ENC_KEY = '0123456789abcdef0123456789abcdef';

function makeMockPool(
  count: number,
): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: [{ count: String(count) }], rowCount: 1 };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('PostgresAccountRepository.getMessageCountToday', () => {
  it('scopes the count query by user_id and account_id', async () => {
    const { pool, calls } = makeMockPool(7);
    const repo = new PostgresAccountRepository(pool, ENC_KEY);

    const result = await repo.getMessageCountToday(USER_ID, ACCOUNT_ID);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const { sql, params } = calls[0];

    // Multi-tenancy: the SQL must carry a user_id predicate and the bound
    // params must include the userId. A raw account_id-only filter is a
    // cross-tenant read of another user's send-log count.
    expect(sql).toMatch(/WHERE[\s\S]*user_id = \$\d/);
    expect(params).toContain(USER_ID);
    expect(params).toContain(ACCOUNT_ID);

    // Return value derives from the mocked response.
    expect(result).toBe(7);
  });
});
