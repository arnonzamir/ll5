import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { captureTools, parseToolResponse } from './_helpers.js';

vi.mock('@ll5/shared', () => ({ logAudit: vi.fn() }));

import { registerContactSettingsTools } from '../tools/contact-settings.js';
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

describe('contact-settings tools', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('get_contact_settings', () => {
    it('lists all contacts when no target is given', async () => {
      const pool = queuedPool([{ rows: [{ target_type: 'group', target_id: 'g@g.us', routing: 'ignore' }] }]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('get_contact_settings')!({});
      const parsed = parseToolResponse<{ count: number; contacts: unknown[] }>(res);
      expect(parsed.count).toBe(1);
      expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatch(/ORDER BY updated_at DESC/);
    });

    it('returns a person row by person_id', async () => {
      const pool = queuedPool([{ rows: [{ target_type: 'person', target_id: 'p1', routing: 'immediate', permission: 'agent', download_media: true }] }]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('get_contact_settings')!({ person_id: 'p1' });
      const parsed = parseToolResponse<{ configured: boolean; routing: string }>(res);
      expect(parsed.configured).toBe(true);
      expect(parsed.routing).toBe('immediate');
    });

    it('reports defaults when a chat has no row', async () => {
      // resolveTarget messaging_contacts lookup → group; then settings lookup → empty
      const pool = queuedPool([
        { rows: [{ is_group: true, person_id: null, display_name: 'Group' }] },
        { rows: [] },
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('get_contact_settings')!({ platform: 'whatsapp', conversation_id: 'g@g.us' });
      const parsed = parseToolResponse<{ configured: boolean; defaults: { permission: string } }>(res);
      expect(parsed.configured).toBe(false);
      expect(parsed.defaults.permission).toBe('input');
    });
  });

  describe('set_contact_settings', () => {
    it('errors when no fields to change are provided', async () => {
      const pool = queuedPool([]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ person_id: 'p1' });
      expect(res.isError).toBe(true);
    });

    it('applies download_media immediately and DEFERS permission to approval', async () => {
      const pool = queuedPool([
        { rows: [{ target_type: 'person', target_id: 'p1', display_name: 'Mom', routing: 'batch', permission: 'input', download_media: true }] }, // immediate upsert (routing/media only)
        { rows: [{ permission: 'input' }] }, // current permission read (defer flow)
        { rows: [{ id: 'req-9' }] }, // INSERT permission_change_requests
        { rows: [] }, // pg_notify
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ person_id: 'p1', permission: 'agent', download_media: true });
      const parsed = parseToolResponse<{ success: boolean; permission_pending_approval: boolean; requested_permission: string; applied: { download_media: boolean } }>(res);
      expect(parsed.success).toBe(true);
      expect(parsed.permission_pending_approval).toBe(true);
      expect(parsed.requested_permission).toBe('agent');
      expect(parsed.applied.download_media).toBe(true);

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
      const allSql = calls.map((c) => c[0] as string).join('\n');
      // The immediate upsert must NOT carry a permission param (it's hard-coded
      // and only updates routing/media); the permission goes to the request table.
      expect(allSql).toMatch(/INSERT INTO contact_settings/);
      expect(allSql).toMatch(/INSERT INTO permission_change_requests/);
      expect(allSql).toMatch(/pg_notify\('permission_approval'/);
      // The contact_settings upsert must not DO UPDATE the permission column.
      const csUpsert = calls.find((c) => /INSERT INTO contact_settings/.test(c[0] as string))![0] as string;
      expect(csUpsert).not.toMatch(/permission = COALESCE/);

      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'permission_change_requested',
        entity_type: 'contact_settings',
        entity_id: 'person:p1',
      }));
    });

    it('with ONLY permission, writes nothing to contact_settings — fully pending', async () => {
      const pool = queuedPool([
        { rows: [{ is_group: true, person_id: null, display_name: 'Group' }] }, // resolveTarget messaging_contacts
        { rows: [{ permission: 'ignore' }] }, // current permission read
        { rows: [{ id: 'req-10' }] }, // INSERT request
        { rows: [] }, // pg_notify
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ platform: 'whatsapp', conversation_id: 'g@g.us', permission: 'agent' });
      const parsed = parseToolResponse<{ success: boolean; permission_pending_approval: boolean; applied?: unknown }>(res);
      expect(parsed.success).toBe(true);
      expect(parsed.permission_pending_approval).toBe(true);
      expect(parsed.applied).toBeUndefined();

      const calls = (pool.query as ReturnType<typeof vi.fn>).mock.calls;
      const allSql = calls.map((c) => c[0] as string).join('\n');
      expect(allSql).not.toMatch(/INSERT INTO contact_settings/);
      expect(allSql).toMatch(/INSERT INTO permission_change_requests/);
    });

    it('applies routing immediately with NO approval request when permission is absent', async () => {
      const pool = queuedPool([
        { rows: [{ target_type: 'person', target_id: 'p1', display_name: 'Mom', routing: 'immediate', permission: 'input', download_media: false }] }, // immediate upsert
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ person_id: 'p1', routing: 'immediate' });
      const parsed = parseToolResponse<{ success: boolean; applied: { routing: string }; permission_pending_approval?: boolean }>(res);
      expect(parsed.success).toBe(true);
      expect(parsed.applied.routing).toBe('immediate');
      expect(parsed.permission_pending_approval).toBeUndefined();

      const allSql = (pool.query as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string).join('\n');
      expect(allSql).not.toMatch(/permission_change_requests/);
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
    });

    it('resolves a 1:1 chat to its linked person target', async () => {
      const pool = queuedPool([
        { rows: [{ is_group: false, person_id: 'p9', display_name: 'Alice' }] }, // messaging_contacts
        { rows: [{ target_type: 'person', target_id: 'p9', display_name: 'Alice', routing: 'ignore', permission: 'input', download_media: false }] }, // upsert
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ platform: 'whatsapp', conversation_id: '972500000000@s.whatsapp.net', routing: 'ignore' });
      const parsed = parseToolResponse<{ applied: { target_type: string; target_id: string } }>(res);
      expect(parsed.applied.target_type).toBe('person');
      expect(parsed.applied.target_id).toBe('p9');
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ entity_id: 'person:p9' }));
    });

    it('errors when no target identifier is provided', async () => {
      const pool = queuedPool([]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ routing: 'ignore' });
      expect(res.isError).toBe(true);
    });
  });
});
