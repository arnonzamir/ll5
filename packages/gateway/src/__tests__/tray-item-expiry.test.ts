import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';

import { TrayItemExpiry } from '../scheduler/tray-item-expiry.js';

const USER_ID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

interface QueryCall { sql: string; params: unknown[] }

function poolCapture(
  handler: (sql: string) => { rowCount: number; rows: Array<Record<string, unknown>> },
): { pool: Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });
    return handler(sql);
  });
  return { pool: { query } as unknown as Pool, calls };
}

const mk = (pool: Pool) => new TrayItemExpiry(pool, { intervalMinutes: 10, userId: USER_ID });
const tick = (s: TrayItemExpiry) => (s as unknown as { tick: () => Promise<void> }).tick();

const expiredRow = (overrides: Record<string, unknown> = {}) => ({
  id: '22222222-2222-2222-2222-222222222222',
  question: 'Park the ROI ingest project?',
  options: [
    { key: 'a', label: 'Park it', recommended: true },
    { key: 'b', label: 'Keep active' },
  ],
  default_key: 'a',
  ...overrides,
});

describe('TrayItemExpiry — decision-card deadline sweep', () => {
  it('flips only open, past-deadline rows of its user and notifies the agent with the default label', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE tray_items/.test(sql)) return { rowCount: 1, rows: [expiredRow()] };
      if (/INSERT INTO chat_messages/.test(sql)) return { rowCount: 1, rows: [{ id: 'msg-1' }] };
      return { rowCount: 0, rows: [] };
    });
    await tick(mk(pool));

    const flip = calls.find((c) => /UPDATE tray_items/.test(c.sql))!;
    expect(flip.sql).toMatch(/SET status = 'expired'/);
    expect(flip.sql).toMatch(/status = 'open'/);
    expect(flip.sql).toMatch(/expires_at IS NOT NULL AND expires_at < now\(\)/);
    expect(flip.params).toEqual([USER_ID]);

    // The sweep only flips + notifies — the AGENT applies the default action.
    const notice = calls.find((c) => /INSERT INTO chat_messages/.test(c.sql))!;
    expect(notice.params[1]).toContain(
      "[Decision] expired: applied default 'Park it' for: Park the ROI ingest project? — user was told the default would apply",
    );
  });

  it('falls back to the recommended option label when default_key is unset', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE tray_items/.test(sql)) return { rowCount: 1, rows: [expiredRow({ default_key: null })] };
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await tick(mk(pool));
    const notice = calls.find((c) => /INSERT INTO chat_messages/.test(c.sql))!;
    expect(notice.params[1]).toContain("applied default 'Park it'");
  });

  it('is silent when nothing has expired', async () => {
    const { pool, calls } = poolCapture(() => ({ rowCount: 0, rows: [] }));
    await tick(mk(pool));
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c.sql))).toBe(false);
  });

  it('skips quietly when tray_items is missing (pre-migration deploy)', async () => {
    const query = vi.fn(async () => {
      const err = new Error('relation "tray_items" does not exist') as Error & { code: string };
      err.code = '42P01';
      throw err;
    });
    const pool = { query } as unknown as Pool;
    await expect(tick(mk(pool))).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
