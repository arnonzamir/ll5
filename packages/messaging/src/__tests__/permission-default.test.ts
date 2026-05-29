import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { getConversationPriority } from '../utils/permission-checker.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import { registerReadMessagesTool } from '../tools/read-messages.js';
import type { AccountRepository, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../clients/evolution.client.js', () => ({
  EvolutionClient: class {
    constructor() {}
    // Return one message so a successful (allowed) read produces messages.
    fetchMessages = vi.fn(async () => [
      { key: { id: 'm1', fromMe: false, remoteJid: '972501234567@s.whatsapp.net' }, pushName: 'X', message: { conversation: 'hi' }, messageTimestamp: 1700000000 },
    ]);
  },
}));

const USER_ID = 'user-1';
const getUserId = () => USER_ID;

/**
 * CONTRACT LOCK — default-allow reads for unconfigured conversations.
 *
 * permission-checker.ts documents (lines 12-19) that a missing
 * contact_settings row returns null, and callers "treat null as default-input
 * authority (read OK, send blocked)". read-messages.ts only blocks when the
 * priority is exactly 'ignore'. Therefore a conversation with NO configured
 * permission is intentionally readable. These tests lock that documented
 * posture so it cannot be silently changed.
 */
describe('permission default posture (contract lock)', () => {
  it('getConversationPriority returns null when no contact_settings row exists', async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as Pool;

    const priority = await getConversationPriority(pool, USER_ID, 'whatsapp', '972501234567@s.whatsapp.net');
    expect(priority).toBeNull();

    // Multi-tenancy: the lookup is scoped by user_id.
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringMatching(/mc\.user_id = \$1/),
      expect.arrayContaining([USER_ID]),
    );
  });

  it('read_messages ALLOWS an unconfigured conversation (null priority is not blocked)', async () => {
    // Pool returns no permission row => unconfigured.
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as Pool;

    const accountRepo = {
      getWhatsApp: vi.fn(async () => ({
        id: 'a1', user_id: USER_ID, instance_name: 'll5', instance_id: 'i1',
        api_url: 'https://evo', api_key: 'k', phone_number: null,
        status: 'connected', last_error: null, last_seen_at: null,
        created_at: new Date(), updated_at: new Date(),
      } as WhatsAppAccountRecord)),
    } as unknown as AccountRepository;

    const conversationRepo = {
      get: vi.fn(async () => ({ account_id: 'a1', platform: 'whatsapp', conversation_id: '972501234567@s.whatsapp.net' } as unknown as ConversationRecord)),
    } as unknown as ConversationRepository;

    const tools = captureTools((s) => registerReadMessagesTool(s, accountRepo, conversationRepo, pool, getUserId));
    const res = await tools.get('read_messages')!({ platform: 'whatsapp', conversation_id: '972501234567@s.whatsapp.net' });

    // Not a permission error — read goes through.
    expect(res.isError).toBeFalsy();
    const body = parseToolResponse<{ messages: unknown[] }>(res);
    expect(Array.isArray(body.messages)).toBe(true);
  });
});
