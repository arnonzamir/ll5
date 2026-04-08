import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NotificationRuleMatcher } from '../processors/notification-rules.js';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake PG pool whose query() returns the given rows. */
function makeMockPool(rows: Record<string, unknown>[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

function makeRule(overrides: Partial<{
  id: string;
  user_id: string;
  rule_type: string;
  match_value: string;
  priority: string;
  platform: string | null;
  download_images: boolean;
}> = {}) {
  return {
    id: overrides.id ?? 'rule-1',
    user_id: overrides.user_id ?? 'user-1',
    rule_type: overrides.rule_type ?? 'wildcard',
    match_value: overrides.match_value ?? '*',
    priority: overrides.priority ?? 'batch',
    platform: overrides.platform ?? null,
    download_images: overrides.download_images ?? false,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationRuleMatcher', () => {
  let matcher: NotificationRuleMatcher;
  let pool: Pool;

  // -----------------------------------------------------------------------
  // Rule type: sender
  // -----------------------------------------------------------------------
  describe('sender rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({ rule_type: 'sender', match_value: 'alice', priority: 'immediate' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('matches sender name (case-insensitive)', async () => {
      const result = await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hello',
      });
      expect(result).toBe('immediate');
    });

    it('matches partial sender name', async () => {
      const result = await matcher.match('user-1', {
        sender: 'Alice Smith',
        app: 'whatsapp',
        body: 'hello',
      });
      expect(result).toBe('immediate');
    });

    it('does not match unrelated sender', async () => {
      const result = await matcher.match('user-1', {
        sender: 'Bob',
        app: 'whatsapp',
        body: 'hello',
      });
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: app
  // -----------------------------------------------------------------------
  describe('app rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({ rule_type: 'app', match_value: 'telegram', priority: 'ignore' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('matches app name (case-insensitive)', async () => {
      const result = await matcher.match('user-1', {
        sender: 'someone',
        app: 'Telegram',
        body: 'hey',
      });
      expect(result).toBe('ignore');
    });

    it('does not match different app', async () => {
      const result = await matcher.match('user-1', {
        sender: 'someone',
        app: 'whatsapp',
        body: 'hey',
      });
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: app_direct / app_group
  // -----------------------------------------------------------------------
  describe('app_direct and app_group rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({ id: 'r1', rule_type: 'app_direct', match_value: 'whatsapp', priority: 'immediate' }),
        makeRule({ id: 'r2', rule_type: 'app_group', match_value: 'whatsapp', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('app_direct matches non-group messages', async () => {
      const result = await matcher.match('user-1', {
        sender: 'someone',
        app: 'whatsapp',
        body: 'hello',
        is_group: false,
      });
      expect(result).toBe('immediate');
    });

    it('app_direct does not match group messages', async () => {
      const result = await matcher.match('user-1', {
        sender: 'someone',
        app: 'whatsapp',
        body: 'hello',
        is_group: true,
      });
      // Should fall through to app_group rule
      expect(result).toBe('batch');
    });

    it('app_group matches group messages', async () => {
      pool = makeMockPool([
        makeRule({ rule_type: 'app_group', match_value: 'whatsapp', priority: 'ignore' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'someone',
        app: 'whatsapp',
        body: 'hello',
        is_group: true,
      });
      expect(result).toBe('ignore');
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: keyword
  // -----------------------------------------------------------------------
  describe('keyword rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({ rule_type: 'keyword', match_value: 'urgent', priority: 'immediate' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('matches keyword in message body (case-insensitive)', async () => {
      const result = await matcher.match('user-1', {
        sender: 'bob',
        app: 'whatsapp',
        body: 'This is URGENT please respond',
      });
      expect(result).toBe('immediate');
    });

    it('does not match when keyword absent', async () => {
      const result = await matcher.match('user-1', {
        sender: 'bob',
        app: 'whatsapp',
        body: 'No rush at all',
      });
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: group
  // -----------------------------------------------------------------------
  describe('group rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({ rule_type: 'group', match_value: 'family', priority: 'immediate' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('matches group name (case-insensitive partial)', async () => {
      const result = await matcher.match('user-1', {
        sender: 'alice',
        app: 'whatsapp',
        body: 'hi',
        is_group: true,
        group_name: 'Family Chat',
      });
      expect(result).toBe('immediate');
    });

    it('does not match non-group messages', async () => {
      const result = await matcher.match('user-1', {
        sender: 'alice',
        app: 'whatsapp',
        body: 'hi',
        is_group: false,
        group_name: null,
      });
      expect(result).toBeNull();
    });

    it('wildcard group matches any group', async () => {
      pool = makeMockPool([
        makeRule({ rule_type: 'group', match_value: '*', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'bob',
        app: 'whatsapp',
        body: 'hey',
        is_group: true,
        group_name: 'Random Group',
      });
      expect(result).toBe('batch');
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: conversation
  // -----------------------------------------------------------------------
  describe('conversation rules', () => {
    beforeEach(() => {
      pool = makeMockPool([
        makeRule({
          rule_type: 'conversation',
          match_value: '972501234567@s.whatsapp.net',
          priority: 'agent',
          platform: 'whatsapp',
        }),
        makeRule({ rule_type: 'sender', match_value: 'alice', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);
    });

    it('conversation rule has highest priority', async () => {
      const result = await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hi',
        platform: 'whatsapp',
        conversation_id: '972501234567@s.whatsapp.net',
      });
      // conversation rule wins over sender rule
      expect(result).toBe('agent');
    });

    it('falls through to pattern rules when conversation does not match', async () => {
      const result = await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hi',
        platform: 'whatsapp',
        conversation_id: '972509999999@s.whatsapp.net',
      });
      // conversation doesn't match → falls to sender rule
      expect(result).toBe('batch');
    });
  });

  // -----------------------------------------------------------------------
  // Rule type: wildcard
  // -----------------------------------------------------------------------
  describe('wildcard rules', () => {
    it('wildcard is used when no other rule matches', async () => {
      pool = makeMockPool([
        makeRule({ id: 'r1', rule_type: 'sender', match_value: 'alice', priority: 'immediate' }),
        makeRule({ id: 'r2', rule_type: 'wildcard', match_value: '*', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'UnknownPerson',
        app: 'whatsapp',
        body: 'hey',
      });
      expect(result).toBe('batch');
    });

    it('specific rule wins over wildcard', async () => {
      pool = makeMockPool([
        makeRule({ id: 'r1', rule_type: 'sender', match_value: 'alice', priority: 'immediate' }),
        makeRule({ id: 'r2', rule_type: 'wildcard', match_value: '*', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hey',
      });
      expect(result).toBe('immediate');
    });
  });

  // -----------------------------------------------------------------------
  // Priority ordering: conversation > sender > wildcard
  // -----------------------------------------------------------------------
  describe('priority ordering', () => {
    it('conversation > sender > wildcard', async () => {
      pool = makeMockPool([
        makeRule({
          id: 'r1',
          rule_type: 'conversation',
          match_value: 'conv-123',
          priority: 'agent',
          platform: 'whatsapp',
        }),
        makeRule({ id: 'r2', rule_type: 'sender', match_value: 'alice', priority: 'immediate' }),
        makeRule({ id: 'r3', rule_type: 'wildcard', match_value: '*', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      // Matches conversation
      expect(await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hi',
        platform: 'whatsapp',
        conversation_id: 'conv-123',
      })).toBe('agent');

      // No conversation match → sender match
      expect(await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hi',
        platform: 'whatsapp',
        conversation_id: 'other-conv',
      })).toBe('immediate');

      // No conversation or sender match → wildcard
      expect(await matcher.match('user-1', {
        sender: 'Bob',
        app: 'whatsapp',
        body: 'hi',
        platform: 'whatsapp',
        conversation_id: 'other-conv',
      })).toBe('batch');
    });
  });

  // -----------------------------------------------------------------------
  // shouldDownloadMedia (replaces shouldDownloadImages)
  // -----------------------------------------------------------------------
  describe('shouldDownloadMedia', () => {
    it('returns true for conversation with download_images enabled (legacy)', async () => {
      // isGroup=false, no personId => skips getContactSettings, goes straight to refresh + legacy
      pool = makeMockPool([
        makeRule({
          rule_type: 'conversation',
          match_value: 'conv-img',
          priority: 'immediate',
          platform: 'whatsapp',
          download_images: true,
        }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      expect(await matcher.shouldDownloadMedia('user-1', 'whatsapp', 'conv-img', false)).toBe(true);
    });

    it('returns false for conversation without download_images (legacy)', async () => {
      pool = makeMockPool([
        makeRule({
          rule_type: 'conversation',
          match_value: 'conv-no-img',
          priority: 'immediate',
          platform: 'whatsapp',
          download_images: false,
        }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      expect(await matcher.shouldDownloadMedia('user-1', 'whatsapp', 'conv-no-img', false)).toBe(false);
    });

    it('returns false for non-conversation rules (legacy)', async () => {
      pool = makeMockPool([
        makeRule({ rule_type: 'sender', match_value: 'alice', priority: 'immediate', download_images: true }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      expect(await matcher.shouldDownloadMedia('user-1', 'whatsapp', 'any-conv', false)).toBe(false);
    });

    it('returns false when no rules for user', async () => {
      pool = makeMockPool([]);
      matcher = new NotificationRuleMatcher(pool);

      expect(await matcher.shouldDownloadMedia('user-1', 'whatsapp', 'any-conv', false)).toBe(false);
    });

    it('returns download_media from contact_settings when available', async () => {
      const mockQuery = vi.fn()
        // getContactSettings returns a match for the group
        .mockResolvedValueOnce({ rows: [{ routing: 'immediate', permission: 'readwrite', download_media: true }] });
      pool = { query: mockQuery } as unknown as Pool;
      matcher = new NotificationRuleMatcher(pool);

      expect(await matcher.shouldDownloadMedia('user-1', 'whatsapp', 'group-conv', true)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Multi-user isolation
  // -----------------------------------------------------------------------
  describe('multi-user isolation', () => {
    it('returns null when no rules exist for the queried user', async () => {
      pool = makeMockPool([
        makeRule({ user_id: 'user-2', rule_type: 'sender', match_value: 'alice', priority: 'immediate' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'Alice',
        app: 'whatsapp',
        body: 'hello',
      });
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Caching / refresh interval
  // -----------------------------------------------------------------------
  describe('caching', () => {
    it('does not re-query the database within the refresh interval', async () => {
      pool = makeMockPool([
        makeRule({ rule_type: 'wildcard', match_value: '*', priority: 'batch' }),
      ]);
      matcher = new NotificationRuleMatcher(pool);

      // First call triggers refresh
      await matcher.match('user-1', { sender: 'a', app: 'b', body: 'c' });
      // Second call should use cache
      await matcher.match('user-1', { sender: 'a', app: 'b', body: 'c' });

      expect(pool.query).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // DB error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    it('returns null if database query fails', async () => {
      pool = {
        query: vi.fn().mockRejectedValue(new Error('DB down')),
      } as unknown as Pool;
      matcher = new NotificationRuleMatcher(pool);

      const result = await matcher.match('user-1', {
        sender: 'alice',
        app: 'whatsapp',
        body: 'hi',
      });
      expect(result).toBeNull();
    });
  });
});
