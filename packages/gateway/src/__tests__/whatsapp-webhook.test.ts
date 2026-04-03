import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processWhatsAppWebhook } from '../processors/whatsapp-webhook.js';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { NotificationRuleMatcher } from '../processors/notification-rules.js';

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

function makeMatcher(
  priority: string | null = null,
  downloadImages = false,
): NotificationRuleMatcher {
  return {
    match: vi.fn().mockResolvedValue(priority),
    shouldDownloadImages: vi.fn().mockResolvedValue(downloadImages),
  } as unknown as NotificationRuleMatcher;
}

interface PayloadOverrides {
  event?: string;
  instance?: string;
  remoteJid?: string;
  fromMe?: boolean;
  id?: string;
  pushName?: string;
  conversation?: string;
  extendedText?: string;
  imageMessage?: {
    url?: string;
    directPath?: string;
    mimetype?: string;
    caption?: string;
    mediaKey?: string;
  };
  messageTimestamp?: number | string;
}

function makePayload(overrides: PayloadOverrides = {}) {
  const message: Record<string, unknown> = {};
  if (overrides.conversation !== undefined) {
    message.conversation = overrides.conversation;
  } else if (overrides.extendedText !== undefined) {
    message.extendedTextMessage = { text: overrides.extendedText };
  } else if (overrides.imageMessage !== undefined) {
    message.imageMessage = overrides.imageMessage;
  } else {
    message.conversation = 'Hello from WhatsApp';
  }

  return {
    event: overrides.event ?? 'messages.upsert',
    instance: overrides.instance ?? 'test-instance',
    data: {
      key: {
        remoteJid: overrides.remoteJid ?? '972501234567@s.whatsapp.net',
        fromMe: overrides.fromMe ?? false,
        id: overrides.id ?? 'msg-id-1',
      },
      pushName: overrides.pushName ?? 'Alice',
      message,
      messageTimestamp: overrides.messageTimestamp ?? 1711878000,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('processWhatsAppWebhook', () => {
  let es: Client;
  let pool: Pool;
  let matcher: NotificationRuleMatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    es = makeEsClient();
    pool = makePgPool();
    matcher = makeMatcher();
  });

  // -----------------------------------------------------------------------
  // Event filtering
  // -----------------------------------------------------------------------
  describe('event filtering', () => {
    it('skips non-messages.upsert events', async () => {
      const payload = makePayload({ event: 'messages.update' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(es.index).not.toHaveBeenCalled();
    });

    it('processes messages.upsert events', async () => {
      const payload = makePayload({ event: 'messages.upsert' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(es.index).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Text message processing
  // -----------------------------------------------------------------------
  describe('text message processing', () => {
    it('extracts text from conversation field', async () => {
      const payload = makePayload({ conversation: 'Hello world' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.content).toBe('Hello world');
    });

    it('extracts text from extendedTextMessage', async () => {
      const payload = makePayload({ conversation: undefined, extendedText: 'Extended text here' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.content).toBe('Extended text here');
    });

    it('skips messages with no text and no image', async () => {
      const payload = makePayload({ conversation: '' });
      // message.conversation is empty string, no image
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(es.index).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Image message detection
  // -----------------------------------------------------------------------
  describe('image message handling', () => {
    it('detects image message and uses caption as text', async () => {
      const payload = makePayload({
        conversation: undefined,
        imageMessage: {
          url: 'https://cdn.whatsapp.net/image.jpg',
          mimetype: 'image/jpeg',
          caption: 'Look at this',
        },
      });
      // Don't download images for this test
      matcher = makeMatcher(null, false);
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.content).toBe('Look at this');
    });

    it('uses [image] placeholder when image has no caption', async () => {
      const payload = makePayload({
        conversation: undefined,
        imageMessage: {
          url: 'https://cdn.whatsapp.net/image.jpg',
          mimetype: 'image/jpeg',
        },
      });
      matcher = makeMatcher(null, false);
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.content).toBe('[image]');
    });
  });

  // -----------------------------------------------------------------------
  // fromMe handling (outbound capture)
  // -----------------------------------------------------------------------
  describe('fromMe handling', () => {
    it('sets sender to (me) for outbound messages', async () => {
      const payload = makePayload({ fromMe: true });
      matcher = makeMatcher('immediate');
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.sender).toBe('(me)');
      expect(doc.from_me).toBe(true);
    });

    it('sets processed=true for fromMe messages', async () => {
      const payload = makePayload({ fromMe: true });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.processed).toBe(true);
    });

    it('does not update entity status for fromMe messages', async () => {
      const payload = makePayload({ fromMe: true });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      // Only one es.index call (message doc), no entity status
      expect(es.index).toHaveBeenCalledTimes(1);
    });

    it('notifies agent for outbound messages when priority is immediate or agent', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      matcher = makeMatcher('immediate');
      const payload = makePayload({ fromMe: true, conversation: 'My outbound message' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(insertSystemMessage).toHaveBeenCalledWith(
        pool,
        'user-1',
        expect.stringContaining('You sent'),
      );
    });

    it('does not notify for outbound messages with batch priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      matcher = makeMatcher('batch');
      const payload = makePayload({ fromMe: true });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(insertSystemMessage).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Inbound message sender extraction
  // -----------------------------------------------------------------------
  describe('sender extraction', () => {
    it('uses pushName for inbound messages', async () => {
      const payload = makePayload({ fromMe: false, pushName: 'Bob Smith' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.sender).toBe('Bob Smith');
    });

    it('falls back to phone number when pushName is missing', async () => {
      const payload = makePayload({
        fromMe: false,
        pushName: undefined,
        remoteJid: '972501234567@s.whatsapp.net',
      });
      // Remove pushName
      delete (payload.data as Record<string, unknown>).pushName;
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.sender).toBe('972501234567');
    });
  });

  // -----------------------------------------------------------------------
  // Group detection
  // -----------------------------------------------------------------------
  describe('group detection', () => {
    it('detects group messages from @g.us JID', async () => {
      const payload = makePayload({ remoteJid: '120363041234567890@g.us' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.is_group).toBe(true);
      expect(doc.group_name).toBe('120363041234567890@g.us');
    });

    it('marks direct messages as non-group', async () => {
      const payload = makePayload({ remoteJid: '972501234567@s.whatsapp.net' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.is_group).toBe(false);
      expect(doc.group_name).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Notification rule integration
  // -----------------------------------------------------------------------
  describe('notification rule integration (inbound)', () => {
    it('marks message as processed for ignore priority', async () => {
      matcher = makeMatcher('ignore');
      const payload = makePayload({ fromMe: false });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(es.update).toHaveBeenCalledWith(expect.objectContaining({
        index: 'll5_awareness_messages',
        doc: { processed: true },
      }));
    });

    it('sends system message for immediate priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      matcher = makeMatcher('immediate');
      const payload = makePayload({ fromMe: false, pushName: 'Charlie' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(insertSystemMessage).toHaveBeenCalledWith(
        pool,
        'user-1',
        expect.stringContaining('Charlie'),
      );
    });

    it('sends system message for agent priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      matcher = makeMatcher('agent');
      const payload = makePayload({ fromMe: false });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(insertSystemMessage).toHaveBeenCalled();
    });

    it('does not send system message for batch priority', async () => {
      const { insertSystemMessage } = await import('../utils/system-message.js');
      matcher = makeMatcher('batch');
      const payload = makePayload({ fromMe: false });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      expect(insertSystemMessage).not.toHaveBeenCalled();
      expect(es.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Entity status update for inbound
  // -----------------------------------------------------------------------
  describe('entity status for inbound messages', () => {
    it('updates entity status for inbound messages', async () => {
      const payload = makePayload({ fromMe: false, pushName: 'Dave' });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      // Should have: 1) message doc, 2) entity status
      expect(es.index).toHaveBeenCalledTimes(2);
      const entityCall = vi.mocked(es.index).mock.calls[1][0] as Record<string, unknown>;
      expect(entityCall.index).toBe('ll5_awareness_entity_statuses');
      const doc = entityCall.document as Record<string, unknown>;
      expect(doc.entity_name).toBe('Dave');
      expect(doc.source).toBe('whatsapp');
    });
  });

  // -----------------------------------------------------------------------
  // Timestamp handling
  // -----------------------------------------------------------------------
  describe('timestamp handling', () => {
    it('converts numeric timestamp to ISO string', async () => {
      const payload = makePayload({ messageTimestamp: 1711878000 });
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      const ts = doc.timestamp as string;
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // Epoch 1711878000 = 2024-03-31T10:00:00.000Z
      expect(new Date(ts).getTime()).toBe(1711878000 * 1000);
    });
  });

  // -----------------------------------------------------------------------
  // Document structure
  // -----------------------------------------------------------------------
  describe('document structure', () => {
    it('indexes with source=evolution', async () => {
      const payload = makePayload();
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.source).toBe('evolution');
      expect(doc.app).toBe('whatsapp');
    });

    it('writes to ll5_awareness_messages index', async () => {
      const payload = makePayload();
      await processWhatsAppWebhook(es, pool, matcher, 'user-1', payload);

      const indexCall = vi.mocked(es.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.index).toBe('ll5_awareness_messages');
    });
  });
});
