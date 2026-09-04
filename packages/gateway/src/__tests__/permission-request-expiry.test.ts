import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';

import { expirePermissionRequests } from '../scheduler/permission-request-expiry.js';

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

const run = (pool: Pool) => expirePermissionRequests(pool, USER_ID);

const expiredRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'faded548-0212-4ce7-8943-09b0681d75eb',
  display_name: 'In Laws',
  target_type: 'person',
  target_id: '59f8c6a2-4786-4d72-9152-7330bc4f694b',
  current_permission: 'agent',
  requested_permission: 'input',
  ...overrides,
});

describe('expirePermissionRequests — authority-request deadline sweep (runs on the TrayItemExpiry tick)', () => {
  it('flips only pending, past-deadline rows of its user', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE permission_change_requests/.test(sql)) return { rowCount: 1, rows: [expiredRow()] };
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await run(pool);

    const flip = calls.find((c) => /UPDATE permission_change_requests/.test(c.sql))!;
    expect(flip.sql).toMatch(/SET status = 'expired'/);
    expect(flip.sql).toMatch(/status = 'pending'/);
    expect(flip.sql).toMatch(/expires_at < now\(\)/);
    expect(flip.params).toEqual([USER_ID]);
  });

  it('tells the agent the change was NOT applied and authority is unchanged (deny default)', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE permission_change_requests/.test(sql)) return { rowCount: 1, rows: [expiredRow()] };
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await run(pool);

    const notice = calls.find((c) => /INSERT INTO chat_messages/.test(c.sql))!;
    const text = notice.params[1] as string;
    expect(text).toContain('In Laws');
    expect(text).toContain('agent → input was NOT applied');
    expect(text).toContain("Authority stays 'agent'");
  });

  it('falls back to the target id when the request has no display_name', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE permission_change_requests/.test(sql)) {
        return { rowCount: 1, rows: [expiredRow({ display_name: null })] };
      }
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await run(pool);

    const notice = calls.find((c) => /INSERT INTO chat_messages/.test(c.sql))!;
    expect(notice.params[1]).toContain('person 59f8c6a2-4786-4d72-9152-7330bc4f694b');
  });

  it('reports the prior authority as "default" when none was set', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE permission_change_requests/.test(sql)) {
        return { rowCount: 1, rows: [expiredRow({ current_permission: null })] };
      }
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await run(pool);

    const notice = calls.find((c) => /INSERT INTO chat_messages/.test(c.sql))!;
    expect(notice.params[1]).toContain("Authority stays 'default'");
  });

  it('notifies once per expired request', async () => {
    const { pool, calls } = poolCapture((sql) => {
      if (/UPDATE permission_change_requests/.test(sql)) {
        return {
          rowCount: 2,
          rows: [expiredRow(), expiredRow({ id: '7c049bb2-f835-422d-bd29-c732e7318183' })],
        };
      }
      return { rowCount: 1, rows: [{ id: 'msg-1' }] };
    });
    await run(pool);

    expect(calls.filter((c) => /INSERT INTO chat_messages/.test(c.sql))).toHaveLength(2);
  });

  it('is silent when nothing has expired', async () => {
    const { pool, calls } = poolCapture(() => ({ rowCount: 0, rows: [] }));
    await run(pool);
    expect(calls).toHaveLength(1);
    expect(calls.some((c) => /INSERT INTO chat_messages/.test(c.sql))).toBe(false);
  });

  it('skips quietly when permission_change_requests is missing (pre-migration deploy)', async () => {
    const query = vi.fn(async () => {
      const err = new Error('relation "permission_change_requests" does not exist') as Error & { code: string };
      err.code = '42P01';
      throw err;
    });
    const pool = { query } as unknown as Pool;
    await expect(run(pool)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
