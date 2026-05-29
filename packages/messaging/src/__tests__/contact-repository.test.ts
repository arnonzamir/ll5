import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { PostgresContactRepository } from '../repositories/postgres/contact.repository.js';
import type { ContactUpsertInput } from '../repositories/interfaces/contact.repository.js';

const infoSpy = vi.fn();
vi.mock('../utils/logger.js', () => ({
  logger: { info: (...a: unknown[]) => infoSpy(...a), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const USER_ID = 'user-uuid-1';

/**
 * A mock pg.Pool that records every query and returns one `{ id }` row per
 * VALUES tuple it sees in the SQL — emulating RETURNING id on a multi-row
 * INSERT. This lets us assert (a) the SQL/params the repo built and (b) the
 * count the repo derived from the response.
 */
function makeMockPool(): { pool: Pool; calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      // Count VALUES tuples: each row is "($1, $2, ...)" => count "now())" markers.
      const rowCount = (sql.match(/now\(\)\)/g) ?? []).length;
      const rows = Array.from({ length: Math.max(rowCount, 1) }, (_, i) => ({ id: `id-${i}` }));
      return { rows, rowCount: rows.length };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('PostgresContactRepository.bulkUpsert', () => {
  beforeEach(() => {
    infoSpy.mockClear();
  });

  it('dedupes a batch containing a duplicate (platform, platform_id) — last wins, upserts once', async () => {
    const { pool, calls } = makeMockPool();
    const repo = new PostgresContactRepository(pool);

    const dupJid = '972501234567@s.whatsapp.net';
    const contacts: ContactUpsertInput[] = [
      { platform: 'whatsapp', platform_id: dupJid, display_name: 'First Name' },
      { platform: 'whatsapp', platform_id: '972509999999@s.whatsapp.net', display_name: 'Other' },
      { platform: 'whatsapp', platform_id: dupJid, display_name: 'Last Name' },
    ];

    const affected = await repo.bulkUpsert(USER_ID, contacts);

    // Exactly one INSERT issued.
    expect(pool.query).toHaveBeenCalledTimes(1);
    const { sql, params } = calls[0];

    // The dup JID must appear exactly once in the param list (deduped),
    // proving we did not emit a second conflicting VALUES tuple for it.
    const dupOccurrences = params.filter((p) => p === dupJid).length;
    expect(dupOccurrences).toBe(1);

    // Two distinct rows => two VALUES tuples.
    expect((sql.match(/now\(\)\)/g) ?? []).length).toBe(2);

    // Last-wins: the surviving display_name for the dup is "Last Name", not "First Name".
    expect(params).toContain('Last Name');
    expect(params).not.toContain('First Name');

    // Return value derives from the (deduped) response: 2 rows.
    expect(affected).toBe(2);

    // Multi-tenancy: user_id is the first bound param and used in the SQL.
    expect(params[0]).toBe(USER_ID);
    expect(sql).toMatch(/\(user_id, platform, platform_id/);
  });

  it('logs deterministic dedupe stats {user_id, platform, input_count, deduped_count}', async () => {
    const { pool } = makeMockPool();
    const repo = new PostgresContactRepository(pool);
    void pool;

    const dupJid = '972501234567@s.whatsapp.net';
    await repo.bulkUpsert(USER_ID, [
      { platform: 'whatsapp', platform_id: dupJid },
      { platform: 'whatsapp', platform_id: dupJid },
    ]);

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('bulkUpsert'),
      expect.objectContaining({
        user_id: USER_ID,
        platform: 'whatsapp',
        input_count: 2,
        deduped_count: 1,
      }),
    );
  });

  it('returns 0 and issues no query for an empty batch', async () => {
    const { pool } = makeMockPool();
    const repo = new PostgresContactRepository(pool);
    const affected = await repo.bulkUpsert(USER_ID, []);
    expect(affected).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
