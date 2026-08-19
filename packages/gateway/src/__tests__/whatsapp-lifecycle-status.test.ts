import { describe, it, expect, vi } from 'vitest';
import { handleWhatsAppLifecycle } from '../processors/whatsapp-lifecycle.js';
import type { DispatchDeps } from '../processors/whatsapp-dispatch.js';

/**
 * Regression lock for the 2026-08-19 silent-status bug.
 *
 * The UPDATE binds $3 twice — once as the assigned value (`SET status = $3`)
 * and once inside a CASE comparison (`$3::text = 'open'`). Without a cast on
 * the ASSIGNMENT too, Postgres deduces conflicting types for the parameter and
 * aborts the whole statement with:
 *
 *   error: inconsistent types deduced for parameter $3
 *
 * The failure is `.catch`-swallowed to a warn, so every status transition was
 * silently not persisted — the account row sat at a stale status while the
 * bridge was actually logged out (observed live: row read `reconnecting` for
 * ~11h across a real logout). A live PG round-trip is the only thing that
 * reproduces the type deduction, so this is a source-level tripwire on the SQL
 * the processor emits.
 */

function depsWithPool(queries: { sql: string; params: unknown[] }[]): DispatchDeps {
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [{ status: 'close', api_url: null, api_key: null }] };
    }),
  };
  return { pgPool: pool } as unknown as DispatchDeps;
}

describe('whatsapp lifecycle status persistence', () => {
  it('casts $3 on the column assignment, not only in the CASE comparison', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    await handleWhatsAppLifecycle(
      depsWithPool(queries),
      'user-1',
      'connection.update',
      'll5',
      { state: 'open' },
    );

    const update = queries.find((q) => q.sql.includes('UPDATE messaging_whatsapp_accounts') && q.sql.includes('SET status'));
    expect(update, 'no status UPDATE was issued').toBeDefined();
    // Both bind sites must carry the cast, or PG aborts the statement.
    expect(update!.sql).toContain('status = $3::text');
    expect(update!.sql).toContain("$3::text = 'open'");
    expect(update!.params[2]).toBe('open');
  });

  it('persists a logged_out transition with a re-pair hint', async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    await handleWhatsAppLifecycle(
      depsWithPool(queries),
      'user-1',
      'logout.instance',
      'll5',
      {},
    );

    const update = queries.find((q) => q.sql.includes('SET status'));
    expect(update).toBeDefined();
    expect(update!.params[2]).toBe('logged_out');
    expect(String(update!.params[3])).toContain('re-pairing');
  });
});
