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

    it('upserts a person setting and audits as contact_settings', async () => {
      const pool = queuedPool([
        { rows: [{ target_type: 'person', target_id: 'p1', display_name: 'Mom', routing: 'immediate', permission: 'agent', download_media: true }] },
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ person_id: 'p1', permission: 'agent', download_media: true });
      const parsed = parseToolResponse<{ success: boolean; permission: string }>(res);
      expect(parsed.success).toBe(true);
      expect(parsed.permission).toBe('agent');
      expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
        entity_type: 'contact_settings',
        entity_id: 'person:p1',
      }));
    });

    it('resolves a 1:1 chat to its linked person target', async () => {
      const pool = queuedPool([
        { rows: [{ is_group: false, person_id: 'p9', display_name: 'Alice' }] }, // messaging_contacts
        { rows: [{ target_type: 'person', target_id: 'p9', display_name: 'Alice', routing: 'ignore', permission: 'input', download_media: false }] }, // upsert
      ]);
      const tools = captureTools((s) => registerContactSettingsTools(s, pool, getUserId));
      const res = await tools.get('set_contact_settings')!({ platform: 'whatsapp', conversation_id: '972500000000@s.whatsapp.net', routing: 'ignore' });
      const parsed = parseToolResponse<{ target_type: string; target_id: string }>(res);
      expect(parsed.target_type).toBe('person');
      expect(parsed.target_id).toBe('p9');
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
