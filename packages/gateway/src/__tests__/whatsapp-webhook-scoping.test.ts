import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processWhatsAppWebhook } from '../processors/whatsapp-webhook.js';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import type { ContactRoutingResolver } from '../processors/contact-routing.js';

vi.mock('../utils/system-message.js', () => ({
  insertSystemMessage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/escalation.js', () => ({
  escalateConversation: vi.fn().mockResolvedValue(undefined),
  isEscalated: vi.fn().mockResolvedValue(false),
}));

const USER_ID = 'user-wa-1';

function makeEsClient(): Client {
  return {
    exists: vi.fn().mockResolvedValue(false),
    index: vi.fn().mockResolvedValue({ _id: 'doc-1', result: 'created' }),
    update: vi.fn().mockResolvedValue({ result: 'updated' }),
  } as unknown as Client;
}

function makeMatcher(downloadMedia = false): ContactRoutingResolver {
  return {
    match: vi.fn().mockResolvedValue('ignore'),
    shouldDownloadMedia: vi.fn().mockResolvedValue(downloadMedia),
    shouldDownloadImages: vi.fn().mockResolvedValue(false),
  } as unknown as ContactRoutingResolver;
}

/** Records every query + its params so we can assert on the WHERE binds. */
function makeRecordingPool(): Pool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  return { query, calls } as unknown as Pool & { calls: Array<{ sql: string; params: unknown[] }> };
}

/**
 * Like makeRecordingPool, but returns a row for the Evolution account lookup so
 * the media-download path proceeds far enough to exercise the account query.
 */
function makeRecordingPoolWithAccount(): Pool & { calls: Array<{ sql: string; params: unknown[] }> } {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes('messaging_whatsapp_accounts')) {
      return { rows: [{ api_url: 'http://evo', api_key: 'k', instance_name: 'inst' }] };
    }
    return { rows: [] };
  });
  return { query, calls } as unknown as Pool & { calls: Array<{ sql: string; params: unknown[] }> };
}

function makePayload(remoteJid: string) {
  return {
    event: 'messages.upsert',
    instance: 'test',
    data: {
      key: { remoteJid, fromMe: false, id: 'm1' },
      pushName: 'Alice',
      message: { conversation: 'hi' },
      messageTimestamp: 1711878000,
    },
  };
}

function makeMediaPayload(remoteJid: string) {
  return {
    event: 'messages.upsert',
    instance: 'test',
    data: {
      key: { remoteJid, fromMe: false, id: 'm2' },
      pushName: 'Alice',
      message: { imageMessage: { url: 'enc://x', mimetype: 'image/jpeg', mediaKey: 'mk' } },
      messageTimestamp: 1711878000,
    },
  };
}

describe('processWhatsAppWebhook — DB lookup user_id scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes the messaging_conversations lookup by user_id', async () => {
    const pool = makeRecordingPool();
    await processWhatsAppWebhook(makeEsClient(), pool, makeMatcher(), USER_ID, makePayload('123@g.us'));

    const convCall = pool.calls.find((c) => c.sql.includes('FROM messaging_conversations'));
    expect(convCall, 'a messaging_conversations lookup must run').toBeDefined();
    expect(convCall!.sql).toMatch(/user_id\s*=\s*\$\d/);
    expect(convCall!.params).toContain(USER_ID);
  });

  it('scopes the messaging_contacts lookup by user_id', async () => {
    const pool = makeRecordingPool();
    await processWhatsAppWebhook(makeEsClient(), pool, makeMatcher(), USER_ID, makePayload('972501234567@s.whatsapp.net'));

    const contactCall = pool.calls.find((c) => c.sql.includes('FROM messaging_contacts'));
    expect(contactCall, 'a messaging_contacts lookup must run').toBeDefined();
    expect(contactCall!.sql).toMatch(/user_id\s*=\s*\$\d/);
    expect(contactCall!.params).toContain(USER_ID);
  });

  it('scopes the Evolution messaging_whatsapp_accounts media-credentials lookup by user_id', async () => {
    // Stub fetch so the media download path runs without network I/O.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 502 }),
    );
    try {
      const pool = makeRecordingPoolWithAccount();
      await processWhatsAppWebhook(
        makeEsClient(),
        pool,
        makeMatcher(true),
        USER_ID,
        makeMediaPayload('972501234567@s.whatsapp.net'),
      );

      const acctCall = pool.calls.find((c) => c.sql.includes('messaging_whatsapp_accounts'));
      expect(acctCall, 'an Evolution account lookup must run for media download').toBeDefined();
      // The account lookup must be tenant-scoped — fetching an arbitrary tenant's
      // Evolution credentials (LIMIT 1, no WHERE) is a cross-tenant vector.
      expect(acctCall!.sql).toMatch(/WHERE.*user_id\s*=\s*\$\d/);
      expect(acctCall!.params).toContain(USER_ID);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
