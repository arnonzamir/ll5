import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';

// Escalation is queried separately; default it off so routing comes from contact_settings.
vi.mock('../utils/escalation.js', () => ({ isEscalated: vi.fn().mockResolvedValue(false) }));

import { ContactRoutingResolver } from '../processors/contact-routing.js';
import { isEscalated } from '../utils/escalation.js';

/** Build a fake PG pool whose query() resolves to the given rows. */
function poolReturning(rows: Record<string, unknown>[]): Pool {
  return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
}

const base = { sender: 'x', app: 'whatsapp', body: 'hi' };

describe('ContactRoutingResolver', () => {
  beforeEach(() => {
    (isEscalated as ReturnType<typeof vi.fn>).mockResolvedValue(false);
  });

  describe('match', () => {
    it('returns group routing from contact_settings', async () => {
      const resolver = new ContactRoutingResolver(
        poolReturning([{ routing: 'immediate', permission: 'input', download_media: false }]),
      );
      const result = await resolver.match('u1', {
        ...base, is_group: true, conversation_id: 'g@g.us', platform: 'whatsapp',
      });
      expect(result).toBe('immediate');
    });

    it('returns person routing for a 1:1 by person_id', async () => {
      const resolver = new ContactRoutingResolver(
        poolReturning([{ routing: 'ignore', permission: 'ignore', download_media: false }]),
      );
      const result = await resolver.match('u1', { ...base, is_group: false, person_id: 'p1' });
      expect(result).toBe('ignore');
    });

    it('returns null when contact_settings has no row', async () => {
      const resolver = new ContactRoutingResolver(poolReturning([]));
      const result = await resolver.match('u1', { ...base, is_group: false, person_id: 'p1' });
      expect(result).toBeNull();
    });

    it('returns null for a 1:1 with no linked person', async () => {
      const pool = poolReturning([]);
      const resolver = new ContactRoutingResolver(pool);
      const result = await resolver.match('u1', { ...base, is_group: false });
      expect(result).toBeNull();
      expect(pool.query).not.toHaveBeenCalled(); // no person_id → no lookup
    });

    it('escalation overrides settings with immediate', async () => {
      (isEscalated as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);
      const resolver = new ContactRoutingResolver(
        poolReturning([{ routing: 'ignore', permission: 'ignore', download_media: false }]),
      );
      const result = await resolver.match('u1', {
        ...base, is_group: true, conversation_id: 'g@g.us', platform: 'whatsapp',
      });
      expect(result).toBe('immediate');
    });

    it('returns null if the settings query throws', async () => {
      const pool = { query: vi.fn().mockRejectedValue(new Error('db down')) } as unknown as Pool;
      const resolver = new ContactRoutingResolver(pool);
      const result = await resolver.match('u1', { ...base, is_group: false, person_id: 'p1' });
      expect(result).toBeNull();
    });
  });

  describe('shouldDownloadMedia', () => {
    it('returns true when the group has download_media enabled', async () => {
      const resolver = new ContactRoutingResolver(
        poolReturning([{ routing: 'batch', permission: 'input', download_media: true }]),
      );
      expect(await resolver.shouldDownloadMedia('u1', 'whatsapp', 'g@g.us', true)).toBe(true);
    });

    it('returns false when the group has no settings row', async () => {
      const resolver = new ContactRoutingResolver(poolReturning([]));
      expect(await resolver.shouldDownloadMedia('u1', 'whatsapp', 'g@g.us', true)).toBe(false);
    });

    it('reads person media via person_id for 1:1', async () => {
      const resolver = new ContactRoutingResolver(
        poolReturning([{ routing: 'batch', permission: 'input', download_media: true }]),
      );
      expect(await resolver.shouldDownloadMedia('u1', 'whatsapp', 'x', false, 'p1')).toBe(true);
    });

    it('returns false for a 1:1 with no linked person', async () => {
      const pool = poolReturning([]);
      const resolver = new ContactRoutingResolver(pool);
      expect(await resolver.shouldDownloadMedia('u1', 'whatsapp', 'x', false)).toBe(false);
      expect(pool.query).not.toHaveBeenCalled();
    });
  });
});
