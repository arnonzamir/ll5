import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processMessage } from '../processors/message.js';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { NotificationRuleMatcher } from '../processors/notification-rules.js';
import type { PushMessageItem } from '../types/index.js';

// ---------------------------------------------------------------------------
// Mock system-message to avoid side effects
// ---------------------------------------------------------------------------
vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEsClient(): Client {
  return {
    index: vi.fn().mockResolvedValue({ _id: 'doc-1', result: 'created' }),
    update: vi.fn().mockResolvedValue({ result: 'updated' }),
  } as unknown as Client;
}

function makePgPool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as Pool;
}

function makeMatcher(priority: string | null = null): NotificationRuleMatcher {
  return {
    match: vi.fn().mockResolvedValue(priority),
    shouldDownloadImages: vi.fn().mockResolvedValue(false),
  } as unknown as NotificationRuleMatcher;
}

function makeMessageItem(overrides: Partial<PushMessageItem> = {}): PushMessageItem {
  return {
    type: 'message',
    timestamp: '2026-03-31T10:00:00.000Z',
    sender: 'Alice',
    app: 'whatsapp',
    body: 'Hello there',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processMessage', () => {
  let es: Client;
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    es = makeEsClient();
    pool = makePgPool();
  });

  // -----------------------------------------------------------------------
  // Basic message indexing
  // -----------------------------------------------------------------------
  describe('message indexing to ES', () => {
    it('writes message document to ll5_awareness_messages', async () => {
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item);

      expect(es.index).toHaveBeenCalledTimes(2); // message + entity status
      const firstCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      expect(firstCall.index).toBe('ll5_awareness_messages');
      const doc = firstCall.document as Record<string, unknown>;
      expect(doc.user_id).toBe('user-1');
      expect(doc.sender).toBe('Alice');
      expect(doc.app).toBe('whatsapp');
      expect(doc.content).toBe('Hello there');
      expect(doc.processed).toBe(false);
    });

    it('includes group info when present', async () => {
      const item = makeMessageItem({
        is_group: true,
        group_name: 'Family Chat',
      });
      await processMessage(es, 'user-1', item);

      const firstCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = firstCall.document as Record<string, unknown>;
      expect(doc.is_group).toBe(true);
      expect(doc.group_name).toBe('Family Chat');
    });

    it('omits group fields when not a group message', async () => {
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item);

      const firstCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = firstCall.document as Record<string, unknown>;
      expect(doc.is_group).toBeUndefined();
      expect(doc.group_name).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Entity status update
  // -----------------------------------------------------------------------
  describe('entity status update', () => {
    it('writes entity status to ll5_awareness_entity_statuses', async () => {
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item);

      // Second es.index call is entity status
      const secondCall = vi.mocked(es.index).mock.calls[1][0] as Record<string, unknown>;
      expect(secondCall.index).toBe('ll5_awareness_entity_statuses');
      const doc = secondCall.document as Record<string, unknown>;
      expect(doc.user_id).toBe('user-1');
      expect(doc.entity_name).toBe('Alice');
      expect(doc.summary).toBe('Hello there');
      expect(doc.source).toBe('whatsapp');
    });

    it('generates deterministic entity ID from user+sender', async () => {
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item);

      const secondCall = vi.mocked(es.index).mock.calls[1][0] as Record<string, unknown>;
      const id = secondCall.id as string;
      expect(id).toBeTruthy();
      expect(id.length).toBe(20);

      // Same sender should produce same ID
      await processMessage(es, 'user-1', item);
      const fourthCall = vi.mocked(es.index).mock.calls[3][0] as Record<string, unknown>;
      expect(fourthCall.id).toBe(id);
    });

    it('continues if entity status update fails', async () => {
      let callCount = 0;
      es.index = vi.fn().mockImplementation((args: Record<string, unknown>) => {
        callCount++;
        if (callCount === 2) {
          // Fail entity status (second call)
          return Promise.reject(new Error('ES error'));
        }
        return Promise.resolve({ _id: 'doc-1', result: 'created' });
      });

      const item = makeMessageItem();
      // Should not throw
      await expect(processMessage(es, 'user-1', item)).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Notification rule matching
  // -----------------------------------------------------------------------
  describe('notification rule matching', () => {
    it('marks message as processed when priority is ignore', async () => {
      const matcher = makeMatcher('ignore');
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item, pool, matcher);

      expect(matcher.match).toHaveBeenCalledWith('user-1', expect.objectContaining({
        sender: 'Alice',
        app: 'whatsapp',
        body: 'Hello there',
      }));
      expect(es.update).toHaveBeenCalledWith(expect.objectContaining({
        index: 'll5_awareness_messages',
        doc: { processed: true },
      }));
    });

    it('sends system message and marks processed for immediate priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher('immediate');
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item, pool, matcher);

      expect(insertSystemMessage).toHaveBeenCalledWith(
        pool,
        'user-1',
        expect.stringContaining('Alice'),
      );
      expect(es.update).toHaveBeenCalledWith(expect.objectContaining({
        doc: { processed: true },
      }));
    });

    it('sends system message for agent priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher('agent');
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item, pool, matcher);

      expect(insertSystemMessage).toHaveBeenCalled();
      expect(es.update).toHaveBeenCalled();
    });

    it('does not send system message for batch priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher('batch');
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item, pool, matcher);

      expect(insertSystemMessage).not.toHaveBeenCalled();
      expect(es.update).not.toHaveBeenCalled();
    });

    it('does not send system message when no rule matches', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher(null);
      const item = makeMessageItem();
      await processMessage(es, 'user-1', item, pool, matcher);

      expect(insertSystemMessage).not.toHaveBeenCalled();
    });

    it('truncates long message bodies in system message', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher('immediate');
      const longBody = 'x'.repeat(3000);
      const item = makeMessageItem({ body: longBody });
      await processMessage(es, 'user-1', item, pool, matcher);

      const call = vi.mocked(insertSystemMessage).mock.calls[0];
      const content = call[2];
      // Body should be truncated to 2000 chars + "..."
      expect(content.length).toBeLessThan(3000);
      expect(content).toContain('...');
    });
  });

  // -----------------------------------------------------------------------
  // Without matcher
  // -----------------------------------------------------------------------
  describe('without matcher', () => {
    it('skips notification rules when matcher is not provided', async () => {
      const item = makeMessageItem();
      // No pool/matcher passed — should still index message + entity status
      await processMessage(es, 'user-1', item);

      expect(es.index).toHaveBeenCalledTimes(2);
      expect(es.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Group info in immediate notification
  // -----------------------------------------------------------------------
  describe('group info in notifications', () => {
    it('includes group info in system message for group messages', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      const matcher = makeMatcher('immediate');
      const item = makeMessageItem({
        is_group: true,
        group_name: 'Work Chat',
      });
      await processMessage(es, 'user-1', item, pool, matcher);

      const call = vi.mocked(insertSystemMessage).mock.calls[0];
      const content = call[2];
      expect(content).toContain('Work Chat');
    });
  });
});
