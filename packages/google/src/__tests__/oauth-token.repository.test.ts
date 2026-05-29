import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresOAuthTokenRepository } from '../repositories/postgres/oauth-token.repository.js';
import { decrypt } from '../utils/encryption.js';

// 32-byte hex key for AES-256-GCM
const KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const USER_ID = 'user-oauth-repo-1';

function makeMockPool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

describe('PostgresOAuthTokenRepository.updateRefreshToken', () => {
  it('encrypts the new refresh token before storing it, scoped to user_id', async () => {
    const { pool, query } = makeMockPool();
    const repo = new PostgresOAuthTokenRepository(pool, KEY);

    await repo.updateRefreshToken(USER_ID, 'rotated-refresh-token');

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];

    // user_id scoping (mandatory)
    expect(sql).toMatch(/WHERE\s+user_id\s*=\s*\$\d/i);
    expect(params).toEqual(expect.arrayContaining([USER_ID]));

    // it must UPDATE refresh_token, not access_token
    expect(sql).toMatch(/refresh_token\s*=\s*\$\d/i);

    // the stored value must be encrypted (not the plaintext) and round-trip back
    const encrypted = params[0] as string;
    expect(encrypted).not.toBe('rotated-refresh-token');
    expect(decrypt(encrypted, KEY)).toBe('rotated-refresh-token');

    // user_id is the WHERE param, not the value being set
    expect(params[params.length - 1]).toBe(USER_ID);
  });
});
