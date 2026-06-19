import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AccountRepository, WhatsAppAccountRecord, TelegramAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';
import { captureTools, parseToolResponse } from './_helpers.js';

// ---------------------------------------------------------------------------
// Mocks — mirror tools.test.ts so the gate is exercised in isolation.
// ---------------------------------------------------------------------------
const mockLogAudit = vi.fn();
vi.mock('@ll5/shared', () => ({
  logAudit: (...args: unknown[]) => mockLogAudit(...args),
}));

const mockSendText = vi.fn();
vi.mock('../clients/evolution.client.js', () => ({
  EvolutionClient: class MockEvolutionClient {
    constructor() {}
    sendText = mockSendText;
  },
}));

const mockTelegramSend = vi.fn();
vi.mock('../clients/telegram.client.js', () => ({
  TelegramClient: class MockTelegramClient {
    constructor() {}
    sendMessage = mockTelegramSend;
  },
}));

const mockGetConversationPriority = vi.fn();
vi.mock('../utils/permission-checker.js', () => ({
  getConversationPriority: (...args: unknown[]) => mockGetConversationPriority(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const USER_ID = 'gate-user-1';
const getUserId = () => USER_ID;
const mockPool = {} as never;

function makeWhatsAppAccount(overrides: Partial<WhatsAppAccountRecord> = {}): WhatsAppAccountRecord {
  return {
    id: 'account-1',
    user_id: USER_ID,
    instance_name: 'test-instance',
    instance_id: 'inst-123',
    api_url: 'https://evo.example.com',
    api_key: 'decrypted-key',
    phone_number: '+972501111111',
    status: 'connected',
    last_error: null,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeTelegramAccount(overrides: Partial<TelegramAccountRecord> = {}): TelegramAccountRecord {
  return {
    id: 'account-tg-1',
    user_id: USER_ID,
    bot_token: 'decrypted-token',
    bot_username: 'mybot',
    bot_name: 'My Bot',
    status: 'connected',
    last_error: null,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    id: 'conv-1',
    user_id: USER_ID,
    account_id: 'account-1',
    platform: 'whatsapp',
    conversation_id: '972501234567@s.whatsapp.net',
    name: 'Test User',
    is_group: false,
    is_archived: false,
    permission: 'agent',
    last_message_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeAccountRepo(overrides: Partial<AccountRepository> = {}): AccountRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`AccountRepository.${name} not stubbed for this test`);
  });
  return {
    listWhatsApp: unimpl('listWhatsApp'),
    listTelegram: unimpl('listTelegram'),
    getWhatsApp: unimpl('getWhatsApp'),
    getTelegram: unimpl('getTelegram'),
    findAccountPlatform: unimpl('findAccountPlatform'),
    updateStatus: unimpl('updateStatus'),
    touchLastSeen: unimpl('touchLastSeen'),
    getMessageCountToday: unimpl('getMessageCountToday'),
    countSentToRecipient: unimpl('countSentToRecipient'),
    logSentMessage: unimpl('logSentMessage'),
    createWhatsApp: unimpl('createWhatsApp'),
    ...overrides,
  } as AccountRepository;
}

function makeConversationRepo(overrides: Partial<ConversationRepository> = {}): ConversationRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`ConversationRepository.${name} not stubbed for this test`);
  });
  return {
    list: unimpl('list'),
    get: unimpl('get'),
    upsert: unimpl('upsert'),
    touchLastMessage: unimpl('touchLastMessage'),
    ...overrides,
  } as ConversationRepository;
}

// ===========================================================================
// send_whatsapp — first-contact gate
// ===========================================================================
describe('send_whatsapp first-contact gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConversationPriority.mockResolvedValue('agent');
  });

  it('blocks (not sent) on first contact without confirmation', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const countSentToRecipient = vi.fn(async () => 0); // never messaged before
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getWhatsApp, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation()),
      touchLastMessage: vi.fn(async () => undefined),
    });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = parseToolResponse<{ sent: boolean; blocked: string; message: string }>(response);
    expect(parsed.sent).toBe(false);
    expect(parsed.blocked).toBe('first_contact_needs_approval');
    expect(parsed.message).toContain('confirmed:true');

    // Did NOT actually send or log a sent message.
    expect(mockSendText).not.toHaveBeenCalled();
    expect(logSentMessage).not.toHaveBeenCalled();

    // Blocked attempt was audited.
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'send_blocked' }),
    );
    expect(countSentToRecipient).toHaveBeenCalledWith(USER_ID, 'whatsapp', '972501234567');
  });

  it('sends on first contact when confirmed:true', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const countSentToRecipient = vi.fn(async () => 0); // first contact
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getWhatsApp, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation()),
      touchLastMessage: vi.fn(async () => undefined),
    });
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-confirmed' });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
      confirmed: true,
    });

    const parsed = parseToolResponse<{ success: boolean; message_id: string }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.message_id).toBe('msg-confirmed');
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(logSentMessage).toHaveBeenCalledWith(USER_ID, 'account-1', 'whatsapp', '972501234567', 'msg-confirmed');
  });

  it('sends without confirmation when a prior outbound exists', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const countSentToRecipient = vi.fn(async () => 5); // established thread
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getWhatsApp, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation()),
      touchLastMessage: vi.fn(async () => undefined),
    });
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-established' });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello again',
    });

    const parsed = parseToolResponse<{ success: boolean; message_id: string }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.message_id).toBe('msg-established');
    expect(mockSendText).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'send_blocked' }),
    );
  });
});

// ===========================================================================
// send_telegram — first-contact gate
// ===========================================================================
describe('send_telegram first-contact gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetConversationPriority.mockResolvedValue('agent');
  });

  it('blocks (not sent) on first contact without confirmation', async () => {
    const getTelegram = vi.fn(async () => makeTelegramAccount());
    const countSentToRecipient = vi.fn(async () => 0);
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getTelegram, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation({ platform: 'telegram', conversation_id: '12345' })),
      touchLastMessage: vi.fn(async () => undefined),
    });

    const { registerSendTelegramTool } = await import('../tools/send-telegram.js');
    const tools = captureTools((s) => registerSendTelegramTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_telegram')!({
      account_id: 'account-tg-1',
      chat_id: '12345',
      message: 'hi',
    });

    const parsed = parseToolResponse<{ sent: boolean; blocked: string }>(response);
    expect(parsed.sent).toBe(false);
    expect(parsed.blocked).toBe('first_contact_needs_approval');
    expect(mockTelegramSend).not.toHaveBeenCalled();
    expect(logSentMessage).not.toHaveBeenCalled();
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'send_blocked' }),
    );
    expect(countSentToRecipient).toHaveBeenCalledWith(USER_ID, 'telegram', '12345');
  });

  it('sends on first contact when confirmed:true', async () => {
    const getTelegram = vi.fn(async () => makeTelegramAccount());
    const countSentToRecipient = vi.fn(async () => 0);
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getTelegram, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation({ platform: 'telegram', conversation_id: '12345' })),
      touchLastMessage: vi.fn(async () => undefined),
    });
    mockTelegramSend.mockResolvedValue({ success: true, message_id: 99 });

    const { registerSendTelegramTool } = await import('../tools/send-telegram.js');
    const tools = captureTools((s) => registerSendTelegramTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_telegram')!({
      account_id: 'account-tg-1',
      chat_id: '12345',
      message: 'hi',
      confirmed: true,
    });

    const parsed = parseToolResponse<{ success: boolean; message_id: number }>(response);
    expect(parsed.success).toBe(true);
    expect(mockTelegramSend).toHaveBeenCalledTimes(1);
    expect(logSentMessage).toHaveBeenCalledWith(USER_ID, 'account-tg-1', 'telegram', '12345', '99');
  });

  it('sends without confirmation when a prior outbound exists', async () => {
    const getTelegram = vi.fn(async () => makeTelegramAccount());
    const countSentToRecipient = vi.fn(async () => 2);
    const logSentMessage = vi.fn(async () => undefined);
    const accountRepo = makeAccountRepo({ getTelegram, countSentToRecipient, logSentMessage });
    const conversationRepo = makeConversationRepo({
      get: vi.fn(async () => makeConversation({ platform: 'telegram', conversation_id: '12345' })),
      touchLastMessage: vi.fn(async () => undefined),
    });
    mockTelegramSend.mockResolvedValue({ success: true, message_id: 100 });

    const { registerSendTelegramTool } = await import('../tools/send-telegram.js');
    const tools = captureTools((s) => registerSendTelegramTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_telegram')!({
      account_id: 'account-tg-1',
      chat_id: '12345',
      message: 'hi again',
    });

    const parsed = parseToolResponse<{ success: boolean }>(response);
    expect(parsed.success).toBe(true);
    expect(mockTelegramSend).toHaveBeenCalledTimes(1);
    expect(mockLogAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'send_blocked' }),
    );
  });
});
