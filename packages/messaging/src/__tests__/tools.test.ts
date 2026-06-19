import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContactRepository, ContactRecord } from '../repositories/interfaces/contact.repository.js';
import type { AccountRepository, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';
import { captureTools, parseToolResponse } from './_helpers.js';

// ---------------------------------------------------------------------------
// Mock: @ll5/shared (logAudit is called in send_whatsapp, sync_whatsapp)
// ---------------------------------------------------------------------------
vi.mock('@ll5/shared', () => ({
  logAudit: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Mock: logger (auto-match-contacts imports it)
// ---------------------------------------------------------------------------
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Mock: evolution client (send-whatsapp, sync-whatsapp create instances)
// ---------------------------------------------------------------------------
const mockSendText = vi.fn();
const mockFindChats = vi.fn();
vi.mock('../clients/evolution.client.js', () => {
  return {
    EvolutionClient: class MockEvolutionClient {
      constructor() {}
      sendText = mockSendText;
      findChats = mockFindChats;
    },
  };
});

// ---------------------------------------------------------------------------
// Mock: permission-checker (send-whatsapp imports getConversationPriority)
// ---------------------------------------------------------------------------
const mockGetConversationPriority = vi.fn();
vi.mock('../utils/permission-checker.js', () => ({
  getConversationPriority: (...args: unknown[]) => mockGetConversationPriority(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 'test-user-id-1234';
const getUserId = () => USER_ID;

function makeContact(overrides: Partial<ContactRecord> = {}): ContactRecord {
  return {
    id: 'contact-1',
    user_id: USER_ID,
    platform: 'whatsapp',
    platform_id: '972501234567@s.whatsapp.net',
    display_name: 'Test User',
    phone_number: '+972501234567',
    is_group: false,
    person_id: null,
    last_seen_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

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

function makeContactRepo(overrides: Partial<ContactRepository> = {}): ContactRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`ContactRepository.${name} not stubbed for this test`);
  });
  return {
    upsert: unimpl('upsert'),
    bulkUpsert: unimpl('bulkUpsert'),
    list: unimpl('list'),
    resolve: unimpl('resolve'),
    linkPerson: unimpl('linkPerson'),
    unlinkPerson: unimpl('unlinkPerson'),
    ...overrides,
  } as ContactRepository;
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
// list_contacts
// ===========================================================================

describe('list_contacts tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards user_id and filters to the repo and returns contacts envelope', async () => {
    const list = vi.fn(async () => ({
      contacts: [makeContact(), makeContact({ id: 'contact-2', display_name: 'Another' })],
      total: 2,
    }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));
    const handler = tools.get('list_contacts');
    expect(handler).toBeDefined();

    const response = await handler!({});

    // Multi-tenancy: handler must forward USER_ID to the repo
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][0]).toBe(USER_ID);

    const parsed = parseToolResponse<{ contacts: Array<{ id: string }>; total: number; count: number }>(response);
    expect(parsed.contacts).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.count).toBe(2);
  });

  it('passes platform filter to repo, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    await tools.get('list_contacts')!({ platform: 'whatsapp' });

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ platform: 'whatsapp' }));
  });

  it('passes query filter to repo, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    await tools.get('list_contacts')!({ query: 'john' });

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ query: 'john' }));
  });

  it('passes is_group filter to repo, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    await tools.get('list_contacts')!({ is_group: true });

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ is_group: true }));
  });

  it('maps linked_only param to hasPersonLink, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    await tools.get('list_contacts')!({ linked_only: false });

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ hasPersonLink: false }));
  });

  it('serializes last_seen_at as ISO string in response envelope', async () => {
    const date = new Date('2026-04-06T10:00:00Z');
    const list = vi.fn(async () => ({
      contacts: [makeContact({ last_seen_at: date })],
      total: 1,
    }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    const response = await tools.get('list_contacts')!({});

    expect(list.mock.calls[0][0]).toBe(USER_ID);
    const parsed = parseToolResponse<{ contacts: Array<{ last_seen_at: string | null }> }>(response);
    expect(parsed.contacts[0].last_seen_at).toBe('2026-04-06T10:00:00.000Z');
  });

  it('serializes null last_seen_at as null', async () => {
    const list = vi.fn(async () => ({
      contacts: [makeContact({ last_seen_at: null })],
      total: 1,
    }));
    const repo = makeContactRepo({ list });

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    const tools = captureTools((s) => registerListContactsTool(s, repo, getUserId));

    const response = await tools.get('list_contacts')!({});

    expect(list.mock.calls[0][0]).toBe(USER_ID);
    const parsed = parseToolResponse<{ contacts: Array<{ last_seen_at: string | null }> }>(response);
    expect(parsed.contacts[0].last_seen_at).toBeNull();
  });
});

// ===========================================================================
// link_contact_to_person / unlink_contact_from_person
// ===========================================================================

describe('link_contact_to_person tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards user_id, contact_id, person_id to repo.linkPerson', async () => {
    const linkPerson = vi.fn(async () => undefined);
    const repo = makeContactRepo({ linkPerson });

    const { registerLinkContactTool } = await import('../tools/link-contact.js');
    const tools = captureTools((s) => registerLinkContactTool(s, repo, getUserId));

    const response = await tools.get('link_contact_to_person')!({
      contact_id: 'contact-1',
      person_id: 'person-abc',
    });

    // Multi-tenancy: USER_ID is the first positional arg
    expect(linkPerson).toHaveBeenCalledWith(USER_ID, 'contact-1', 'person-abc');

    const parsed = parseToolResponse<{ success: boolean }>(response);
    expect(parsed.success).toBe(true);
  });

  it('returns CONTACT_NOT_FOUND isError envelope when repo throws CONTACT_NOT_FOUND', async () => {
    const linkPerson = vi.fn(async () => { throw new Error('CONTACT_NOT_FOUND'); });
    const repo = makeContactRepo({ linkPerson });

    const { registerLinkContactTool } = await import('../tools/link-contact.js');
    const tools = captureTools((s) => registerLinkContactTool(s, repo, getUserId));

    const response = await tools.get('link_contact_to_person')!({
      contact_id: 'nonexistent',
      person_id: 'person-abc',
    });

    expect(linkPerson).toHaveBeenCalledWith(USER_ID, 'nonexistent', 'person-abc');
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('CONTACT_NOT_FOUND');
  });

  it('re-throws unexpected errors', async () => {
    const linkPerson = vi.fn(async () => { throw new Error('DB_CONNECTION_LOST'); });
    const repo = makeContactRepo({ linkPerson });

    const { registerLinkContactTool } = await import('../tools/link-contact.js');
    const tools = captureTools((s) => registerLinkContactTool(s, repo, getUserId));

    await expect(
      tools.get('link_contact_to_person')!({ contact_id: 'contact-1', person_id: 'person-abc' }),
    ).rejects.toThrow('DB_CONNECTION_LOST');
    expect(linkPerson).toHaveBeenCalledWith(USER_ID, 'contact-1', 'person-abc');
  });
});

describe('unlink_contact_from_person tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards user_id and contact_id to repo.unlinkPerson', async () => {
    const unlinkPerson = vi.fn(async () => undefined);
    const repo = makeContactRepo({ unlinkPerson });

    const { registerUnlinkContactTool } = await import('../tools/link-contact.js');
    const tools = captureTools((s) => registerUnlinkContactTool(s, repo, getUserId));

    const response = await tools.get('unlink_contact_from_person')!({
      contact_id: 'contact-1',
    });

    expect(unlinkPerson).toHaveBeenCalledWith(USER_ID, 'contact-1');
    const parsed = parseToolResponse<{ success: boolean }>(response);
    expect(parsed.success).toBe(true);
  });

  it('returns CONTACT_NOT_FOUND isError envelope when repo throws CONTACT_NOT_FOUND', async () => {
    const unlinkPerson = vi.fn(async () => { throw new Error('CONTACT_NOT_FOUND'); });
    const repo = makeContactRepo({ unlinkPerson });

    const { registerUnlinkContactTool } = await import('../tools/link-contact.js');
    const tools = captureTools((s) => registerUnlinkContactTool(s, repo, getUserId));

    const response = await tools.get('unlink_contact_from_person')!({
      contact_id: 'nonexistent',
    });

    expect(unlinkPerson).toHaveBeenCalledWith(USER_ID, 'nonexistent');
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('CONTACT_NOT_FOUND');
  });
});

// ===========================================================================
// auto_match_contacts (kept — previously passing real tests)
// ===========================================================================

describe('auto_match_contacts tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('filters out groups and unnamed contacts; forwards user_id', async () => {
    const list = vi.fn(async () => ({
      contacts: [
        makeContact({ id: 'c1', display_name: 'Alice', is_group: false }),
        makeContact({ id: 'c2', display_name: null, is_group: false }),
        makeContact({ id: 'c3', display_name: 'Group Chat', is_group: true }),
        makeContact({ id: 'c4', display_name: 'Bob', is_group: false }),
      ],
      total: 4,
    }));
    const repo = makeContactRepo({ list });

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    const tools = captureTools((s) => registerAutoMatchContactsTool(s, repo, getUserId));

    const response = await tools.get('auto_match_contacts')!({});

    expect(list.mock.calls[0][0]).toBe(USER_ID);
    const parsed = parseToolResponse<{ unlinked_contacts: Array<{ contact_name: string }>; count: number }>(response);
    expect(parsed.unlinked_contacts).toHaveLength(2);
    expect(parsed.count).toBe(2);
    expect(parsed.unlinked_contacts[0].contact_name).toBe('Alice');
    expect(parsed.unlinked_contacts[1].contact_name).toBe('Bob');
  });

  it('queries for unlinked contacts only (hasPersonLink: false), scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    const tools = captureTools((s) => registerAutoMatchContactsTool(s, repo, getUserId));

    await tools.get('auto_match_contacts')!({});

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ hasPersonLink: false }));
  });

  it('respects platform filter, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    const tools = captureTools((s) => registerAutoMatchContactsTool(s, repo, getUserId));

    await tools.get('auto_match_contacts')!({ platform: 'telegram' });

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ platform: 'telegram' }));
  });

  it('uses default limit of 200, scoped to user_id', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    const tools = captureTools((s) => registerAutoMatchContactsTool(s, repo, getUserId));

    await tools.get('auto_match_contacts')!({});

    expect(list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: 200 }));
  });

  it('includes instructions for linking in response envelope', async () => {
    const list = vi.fn(async () => ({ contacts: [], total: 0 }));
    const repo = makeContactRepo({ list });

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    const tools = captureTools((s) => registerAutoMatchContactsTool(s, repo, getUserId));

    const response = await tools.get('auto_match_contacts')!({});

    const parsed = parseToolResponse<{ instructions: string }>(response);
    expect(parsed.instructions).toContain('link_contact_to_person');
  });
});

// ===========================================================================
// send_whatsapp (kept — previously passing real tests, with multi-tenancy)
// ===========================================================================

describe('send_whatsapp tool handler', () => {
  const mockPool = {} as never;

  beforeEach(() => vi.clearAllMocks());

  it('returns ACCOUNT_NOT_FOUND when account does not exist; scoped to user_id', async () => {
    const getWhatsApp = vi.fn(async () => null);
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'nonexistent',
      to: '972501234567',
      message: 'hello',
    });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'nonexistent');
    expect(response.isError).toBe(true);
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns ACCOUNT_DISCONNECTED when account is not connected', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount({ status: 'disconnected' }));
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'account-1');
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_DISCONNECTED');
  });

  it('returns PERMISSION_DENIED when priority is not agent', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();
    mockGetConversationPriority.mockResolvedValue('batch');

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'account-1');
    const parsed = parseToolResponse<{ error: string; priority: string }>(response);
    expect(parsed.error).toBe('PERMISSION_DENIED');
    expect(parsed.priority).toBe('batch');
  });

  it('returns PERMISSION_DENIED when no rule exists (null priority)', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();
    mockGetConversationPriority.mockResolvedValue(null);

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = parseToolResponse<{ error: string; priority: string }>(response);
    expect(parsed.error).toBe('PERMISSION_DENIED');
    expect(parsed.priority).toBe('no-rule');
  });

  it('sends message when priority is agent; logs send under user_id', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const logSentMessage = vi.fn(async () => undefined);
    const countSentToRecipient = vi.fn(async () => 3);
    const accountRepo = makeAccountRepo({ getWhatsApp, logSentMessage, countSentToRecipient });
    const get = vi.fn(async () => makeConversation());
    const conversationRepo = makeConversationRepo({ get, touchLastMessage: vi.fn(async () => undefined) });
    mockGetConversationPriority.mockResolvedValue('agent');
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-123' });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = parseToolResponse<{ success: boolean; message_id: string }>(response);
    expect(parsed.success).toBe(true);
    expect(parsed.message_id).toBe('msg-123');
    expect(logSentMessage).toHaveBeenCalledWith(USER_ID, 'account-1', 'whatsapp', '972501234567', 'msg-123');
  });

  it('appends @s.whatsapp.net for conversation lookup and forwards user_id to permission check', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const logSentMessage = vi.fn(async () => undefined);
    const countSentToRecipient = vi.fn(async () => 3);
    const accountRepo = makeAccountRepo({ getWhatsApp, logSentMessage, countSentToRecipient });
    const get = vi.fn(async () => null);
    const conversationRepo = makeConversationRepo({ get, touchLastMessage: vi.fn(async () => undefined) });
    mockGetConversationPriority.mockResolvedValue('agent');
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-456' });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    expect(mockGetConversationPriority).toHaveBeenCalledWith(
      mockPool, USER_ID, 'whatsapp', '972501234567@s.whatsapp.net',
    );
  });

  it('preserves existing JID suffix in to field', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const logSentMessage = vi.fn(async () => undefined);
    const countSentToRecipient = vi.fn(async () => 3);
    const accountRepo = makeAccountRepo({ getWhatsApp, logSentMessage, countSentToRecipient });
    const get = vi.fn(async () => null);
    const conversationRepo = makeConversationRepo({ get, touchLastMessage: vi.fn(async () => undefined) });
    mockGetConversationPriority.mockResolvedValue('agent');
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-789' });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567@s.whatsapp.net',
      message: 'hello',
    });

    expect(mockGetConversationPriority).toHaveBeenCalledWith(
      mockPool, USER_ID, 'whatsapp', '972501234567@s.whatsapp.net',
    );
  });

  it('returns SEND_FAILED when Evolution API returns failure', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const countSentToRecipient = vi.fn(async () => 3);
    const accountRepo = makeAccountRepo({ getWhatsApp, logSentMessage: vi.fn(), countSentToRecipient });
    const get = vi.fn(async () => makeConversation());
    const conversationRepo = makeConversationRepo({ get, touchLastMessage: vi.fn(async () => undefined) });
    mockGetConversationPriority.mockResolvedValue('agent');
    mockSendText.mockResolvedValue({ success: false, message_id: null });

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    const tools = captureTools((s) => registerSendWhatsAppTool(s, accountRepo, conversationRepo, mockPool, getUserId));

    const response = await tools.get('send_whatsapp')!({
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('SEND_FAILED');
  });
});

// ===========================================================================
// sync_whatsapp_conversations (kept — previously passing real tests)
// ===========================================================================

describe('sync_whatsapp_conversations tool handler', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns ACCOUNT_NOT_FOUND when account does not exist; user_id scoped', async () => {
    const getWhatsApp = vi.fn(async () => null);
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();
    const contactRepo = makeContactRepo();

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    const tools = captureTools((s) => registerSyncWhatsAppTool(s, accountRepo, conversationRepo, contactRepo, getUserId));

    const response = await tools.get('sync_whatsapp_conversations')!({
      account_id: 'nonexistent',
    });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'nonexistent');
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns ACCOUNT_DISCONNECTED when account is not connected', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount({ status: 'qr_pending' }));
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const conversationRepo = makeConversationRepo();
    const contactRepo = makeContactRepo();

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    const tools = captureTools((s) => registerSyncWhatsAppTool(s, accountRepo, conversationRepo, contactRepo, getUserId));

    const response = await tools.get('sync_whatsapp_conversations')!({
      account_id: 'account-1',
    });

    expect(getWhatsApp).toHaveBeenCalledWith(USER_ID, 'account-1');
    const parsed = parseToolResponse<{ error: string }>(response);
    expect(parsed.error).toBe('ACCOUNT_DISCONNECTED');
  });

  it('upserts conversations and contacts from chats; scoped to user_id', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const upsert = vi.fn(async () => ({ created: true }));
    const list = vi.fn(async () => ({ conversations: [], total: 5 }));
    const conversationRepo = makeConversationRepo({ upsert, list, touchLastMessage: vi.fn() });
    const bulkUpsert = vi.fn(async () => 2);
    const contactRepo = makeContactRepo({ bulkUpsert });

    mockFindChats.mockResolvedValue({
      chats: [
        { id: '972501234567@s.whatsapp.net', name: 'Alice', isGroup: false, isArchived: false, lastMessageTimestamp: 1700000000 },
        { id: '972509876543@s.whatsapp.net', name: 'Bob', isGroup: false, isArchived: false },
      ],
      contacts: [
        { remoteJid: '972501234567@s.whatsapp.net', pushName: 'Alice' },
      ],
    });

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    const tools = captureTools((s) => registerSyncWhatsAppTool(s, accountRepo, conversationRepo, contactRepo, getUserId));

    const response = await tools.get('sync_whatsapp_conversations')!({
      account_id: 'account-1',
    });

    expect(upsert.mock.calls[0][0]).toBe(USER_ID);
    expect(bulkUpsert).toHaveBeenCalled();
    expect(bulkUpsert.mock.calls[0][0]).toBe(USER_ID);
    const parsed = parseToolResponse<{ total_conversations: number; new_conversations: number }>(response);
    expect(parsed.total_conversations).toBe(5);
    expect(parsed.new_conversations).toBe(2);
  });

  it('counts new vs updated conversations correctly', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const upsert = vi.fn()
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false });
    const list = vi.fn(async () => ({ conversations: [], total: 10 }));
    const conversationRepo = makeConversationRepo({ upsert, list, touchLastMessage: vi.fn() });
    const contactRepo = makeContactRepo({ bulkUpsert: vi.fn(async () => 0) });

    mockFindChats.mockResolvedValue({
      chats: [
        { id: 'chat-1@s.whatsapp.net', name: 'New Chat', isGroup: false, isArchived: false },
        { id: 'chat-2@s.whatsapp.net', name: 'Existing Chat', isGroup: false, isArchived: false },
      ],
      contacts: [],
    });

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    const tools = captureTools((s) => registerSyncWhatsAppTool(s, accountRepo, conversationRepo, contactRepo, getUserId));

    const response = await tools.get('sync_whatsapp_conversations')!({
      account_id: 'account-1',
    });

    const parsed = parseToolResponse<{ new_conversations: number; updated_conversations: number }>(response);
    expect(parsed.new_conversations).toBe(1);
    expect(parsed.updated_conversations).toBe(1);
  });

  it('updates last_message_at via touchLastMessage when timestamp provided; scoped to user_id', async () => {
    const getWhatsApp = vi.fn(async () => makeWhatsAppAccount());
    const accountRepo = makeAccountRepo({ getWhatsApp });
    const touchLastMessage = vi.fn(async () => undefined);
    const conversationRepo = makeConversationRepo({
      upsert: vi.fn(async () => ({ created: true })),
      list: vi.fn(async () => ({ conversations: [], total: 1 })),
      touchLastMessage,
    });
    const contactRepo = makeContactRepo({ bulkUpsert: vi.fn(async () => 0) });

    mockFindChats.mockResolvedValue({
      chats: [
        { id: 'chat-1@s.whatsapp.net', name: 'Chat', isGroup: false, isArchived: false, lastMessageTimestamp: 1700000000 },
      ],
      contacts: [],
    });

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    const tools = captureTools((s) => registerSyncWhatsAppTool(s, accountRepo, conversationRepo, contactRepo, getUserId));

    await tools.get('sync_whatsapp_conversations')!({ account_id: 'account-1' });

    expect(touchLastMessage).toHaveBeenCalledWith(
      USER_ID, 'whatsapp', 'chat-1@s.whatsapp.net',
      new Date(1700000000 * 1000),
    );
  });
});
