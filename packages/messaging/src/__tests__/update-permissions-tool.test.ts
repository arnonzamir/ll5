import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { captureTools, parseToolResponse } from './_helpers.js';

vi.mock('@ll5/shared', () => ({ logAudit: vi.fn() }));

import { registerUpdatePermissionsTool } from '../tools/update-permissions.js';
import { logAudit } from '@ll5/shared';

const USER_ID = 'user-1';
const getUserId = () => USER_ID;

/** A pg Pool whose query() returns queued result sets in order. */
function queuedPool(results: Array<{ rows: Record<string, unknown>[] }>): Pool {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  query.mockResolvedValue({ rows: [] });
  return { query } as unknown as Pool;
}

describe('update_conversation_permissions tool (approval-gated)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('files a PENDING request and does NOT write contact_settings (group chat)', async () => {
    const pool = queuedPool([
      { rows: [{ is_group: true, person_id: null, display_name: 'Sunbit IL' }] }, // messaging_contacts
      { rows: [{ permission: 'input' }] }, // current permission read
      { rows: [{ id: 'req-1' }] }, // INSERT permission_change_requests ... RETURNING id
      { rows: [] }, // pg_notify
    ]);
    const tools = captureTools((s) => registerUpdatePermissionsTool(s, pool, getUserId));
    const res = await tools.get('update_conversation_permissions')!({
      platform: 'whatsapp',
      conversation_id: '123@g.us',
      permission: 'agent',
    });

    const parsed = parseToolResponse<{ pending_approval: boolean; request_id: string; target_type: string; target_id: string; requested_permission: string; current_permission: string }>(res);
    expect(parsed.pending_approval).toBe(true);
    expect(parsed.request_id).toBe('req-1');
    expect(parsed.target_type).toBe('group');
    expect(parsed.target_id).toBe('123@g.us');
    expect(parsed.requested_permission).toBe('agent');
    expect(parsed.current_permission).toBe('input');

    const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
    const allSql = calls.map((c) => c[0] as string).join('\n');
    // It must file a request and NOTIFY — and must NOT upsert contact_settings.
    expect(allSql).toMatch(/INSERT INTO permission_change_requests/);
    expect(allSql).toMatch(/pg_notify\('permission_approval'/);
    expect(allSql).not.toMatch(/INSERT INTO contact_settings/);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'permission_change_requested',
      entity_type: 'contact_settings',
      entity_id: 'group:123@g.us',
    }));
  });

  it('resolves a linked 1:1 chat to its person target in the request', async () => {
    const pool = queuedPool([
      { rows: [{ is_group: false, person_id: 'p9', display_name: 'Alice' }] }, // messaging_contacts
      { rows: [] }, // current permission read (no row → null)
      { rows: [{ id: 'req-2' }] }, // INSERT request
      { rows: [] }, // pg_notify
    ]);
    const tools = captureTools((s) => registerUpdatePermissionsTool(s, pool, getUserId));
    const res = await tools.get('update_conversation_permissions')!({
      platform: 'whatsapp',
      conversation_id: '972500000000@s.whatsapp.net',
      permission: 'input',
    });

    const parsed = parseToolResponse<{ pending_approval: boolean; target_type: string; target_id: string; requested_permission: string }>(res);
    expect(parsed.pending_approval).toBe(true);
    expect(parsed.target_type).toBe('person');
    expect(parsed.target_id).toBe('p9');
    expect(parsed.requested_permission).toBe('input');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'permission_change_requested',
      entity_id: 'person:p9',
    }));
  });
});
