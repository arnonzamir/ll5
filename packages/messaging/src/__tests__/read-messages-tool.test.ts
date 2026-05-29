import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Pool } from 'pg';
import { captureTools, parseToolResponse } from './_helpers.js';
import { registerReadMessagesTool } from '../tools/read-messages.js';
import type { AccountRepository, TelegramAccountRecord, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Telegram client must NOT be invoked for history. If the code under test
// calls getUpdates, this spy lets us detect the unsafe queue-consumption.
const mockGetUpdates = vi.fn();
vi.mock('../clients/telegram.client.js', () => ({
  TelegramClient: class {
    constructor() {}
    getUpdates = mockGetUpdates;
  },
}));

vi.mock('../clients/evolution.client.js', () => ({
  EvolutionClient: class {
    constructor() {}
    fetchMessages = vi.fn(async () => []);
  },
}));

const USER_ID = 'user-1';
const getUserId = () => USER_ID;

function makeTelegramAccount(overrides: Partial<TelegramAccountRecord> = {}): TelegramAccountRecord {
  return {
    id: 'tg-account-1',
    user_id: USER_ID,
    bot_token: 'bot-token',
    bot_username: 'bot',
    bot_name: 'Bot',
    status: 'connected',
    last_error: null,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  } as TelegramAccountRecord;
}

function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    account_id: 'tg-account-1',
    platform: 'telegram',
    conversation_id: '12345',
    name: 'Chat',
    is_group: false,
    is_archived: false,
    unread_count: 0,
  } as unknown as ConversationRecord;
}

function makeAccountRepo(): AccountRepository {
  return {
    getTelegram: vi.fn(async () => makeTelegramAccount()),
    getWhatsApp: vi.fn(async () => null as WhatsAppAccountRecord | null),
  } as unknown as AccountRepository;
}

function makeConversationRepo(): ConversationRepository {
  return {
    get: vi.fn(async () => makeConversation()),
  } as unknown as ConversationRepository;
}

// Mock pool: permission lookup returns a configured 'agent' row so the
// permission gate is satisfied and we reach the Telegram branch.
function makeMockPool(): Pool {
  return {
    query: vi.fn(async () => ({ rows: [{ permission: 'agent' }], rowCount: 1 })),
  } as unknown as Pool;
}

describe('read_messages Telegram history', () => {
  beforeEach(() => {
    mockGetUpdates.mockReset();
  });

  it('does NOT consume the Telegram update queue via getUpdates for history', async () => {
    const tools = captureTools((s) =>
      registerReadMessagesTool(s, makeAccountRepo(), makeConversationRepo(), makeMockPool(), getUserId),
    );

    const res = await tools.get('read_messages')!({ platform: 'telegram', conversation_id: '12345', limit: 20 });

    // The unsafe call must never happen.
    expect(mockGetUpdates).not.toHaveBeenCalled();

    // It returns a clear not-supported error rather than silently draining updates.
    expect(res.isError).toBe(true);
    const body = parseToolResponse<{ error: string }>(res);
    expect(body.error).toBe('TELEGRAM_HISTORY_NOT_SUPPORTED');
  });
});
