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

describe('update_conversation_permissions tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes contact_settings.permission for a group chat (keyed on the JID)', async () => {
    const pool = queuedPool([
      { rows: [{ is_group: true, person_id: null, display_name: 'Sunbit IL' }] }, // messaging_contacts
      { rows: [{ id: 'cs-1' }] }, // INSERT ... RETURNING id
    ]);
    const tools = captureTools((s) => registerUpdatePermissionsTool(s, pool, getUserId));
    const res = await tools.get('update_conversation_permissions')!({
      platform: 'whatsapp',
      conversation_id: '123@g.us',
      permission: 'agent',
    });

    const parsed = parseToolResponse<{ success: boolean; target_type: string; target_id: string; permission: string }>(res);
    expect(parsed.success).toBe(true);
    expect(parsed.target_type).toBe('group');
    expect(parsed.target_id).toBe('123@g.us');
    expect(parsed.permission).toBe('agent');

    // The write must target contact_settings.permission — not the retired column.
    const insertSql = (pool.query as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(insertSql).toMatch(/INSERT INTO contact_settings/);
    expect(insertSql).toMatch(/permission/);
    expect(insertSql).not.toMatch(/messaging_conversations/);

    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'contact_settings',
      entity_id: 'group:123@g.us',
    }));
  });

  it('resolves a linked 1:1 chat to its person target', async () => {
    const pool = queuedPool([
      { rows: [{ is_group: false, person_id: 'p9', display_name: 'Alice' }] }, // messaging_contacts
      { rows: [{ id: 'cs-2' }] }, // INSERT ... RETURNING id
    ]);
    const tools = captureTools((s) => registerUpdatePermissionsTool(s, pool, getUserId));
    const res = await tools.get('update_conversation_permissions')!({
      platform: 'whatsapp',
      conversation_id: '972500000000@s.whatsapp.net',
      permission: 'input',
    });

    const parsed = parseToolResponse<{ target_type: string; target_id: string; permission: string }>(res);
    expect(parsed.target_type).toBe('person');
    expect(parsed.target_id).toBe('p9');
    expect(parsed.permission).toBe('input');
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'person:p9' }));
  });
});
