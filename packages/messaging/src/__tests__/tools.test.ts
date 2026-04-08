import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContactRepository, ContactRecord, ContactListResult } from '../repositories/interfaces/contact.repository.js';
import type { AccountRepository, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';

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

/** Helper to invoke a registered MCP tool handler by simulating the registration. */
function createMockServer() {
  const tools = new Map<string, { handler: (params: Record<string, unknown>) => Promise<unknown> }>();
  return {
    tool: (name: string, _desc: string, _schema: unknown, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, { handler });
    },
    call: async (name: string, params: Record<string, unknown> = {}) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not registered`);
      return tool.handler(params);
    },
  };
}

// ---------------------------------------------------------------------------
// list_contacts
// ---------------------------------------------------------------------------

describe('list_contacts', () => {
  let server: ReturnType<typeof createMockServer>;
  let contactRepo: ContactRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    contactRepo = {
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      list: vi.fn(),
      resolve: vi.fn(),
      linkPerson: vi.fn(),
      unlinkPerson: vi.fn(),
    };

    const { registerListContactsTool } = await import('../tools/list-contacts.js');
    registerListContactsTool(server as any, contactRepo, getUserId);
  });

  it('returns contacts with total count', async () => {
    const contacts = [makeContact(), makeContact({ id: 'contact-2', display_name: 'Another' })];
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts, total: 2 });

    const result = await server.call('list_contacts', {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.contacts).toHaveLength(2);
    expect(parsed.total).toBe(2);
    expect(parsed.count).toBe(2);
  });

  it('passes platform filter to repo', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('list_contacts', { platform: 'whatsapp' });

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      platform: 'whatsapp',
    }));
  });

  it('passes query filter to repo', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('list_contacts', { query: 'john' });

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      query: 'john',
    }));
  });

  it('passes is_group filter to repo', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('list_contacts', { is_group: true });

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      is_group: true,
    }));
  });

  it('passes linked_only as hasPersonLink', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('list_contacts', { linked_only: false });

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      hasPersonLink: false,
    }));
  });

  it('serializes last_seen_at as ISO string', async () => {
    const date = new Date('2026-04-06T10:00:00Z');
    vi.mocked(contactRepo.list).mockResolvedValue({
      contacts: [makeContact({ last_seen_at: date })],
      total: 1,
    });

    const result = await server.call('list_contacts', {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.contacts[0].last_seen_at).toBe('2026-04-06T10:00:00.000Z');
  });

  it('serializes null last_seen_at as null', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({
      contacts: [makeContact({ last_seen_at: null })],
      total: 1,
    });

    const result = await server.call('list_contacts', {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.contacts[0].last_seen_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// link_contact_to_person / unlink_contact_from_person
// ---------------------------------------------------------------------------

describe('link_contact_to_person', () => {
  let server: ReturnType<typeof createMockServer>;
  let contactRepo: ContactRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    contactRepo = {
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      list: vi.fn(),
      resolve: vi.fn(),
      linkPerson: vi.fn(),
      unlinkPerson: vi.fn(),
    };

    const { registerLinkContactTool, registerUnlinkContactTool } = await import('../tools/link-contact.js');
    registerLinkContactTool(server as any, contactRepo, getUserId);
    registerUnlinkContactTool(server as any, contactRepo, getUserId);
  });

  it('calls contactRepo.linkPerson with correct arguments', async () => {
    vi.mocked(contactRepo.linkPerson).mockResolvedValue(undefined);

    const result = await server.call('link_contact_to_person', {
      contact_id: 'contact-1',
      person_id: 'person-abc',
    });

    expect(contactRepo.linkPerson).toHaveBeenCalledWith(USER_ID, 'contact-1', 'person-abc');
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
  });

  it('returns CONTACT_NOT_FOUND error when contact missing', async () => {
    vi.mocked(contactRepo.linkPerson).mockRejectedValue(new Error('CONTACT_NOT_FOUND'));

    const result = await server.call('link_contact_to_person', {
      contact_id: 'nonexistent',
      person_id: 'person-abc',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('CONTACT_NOT_FOUND');
    expect((result as any).isError).toBe(true);
  });

  it('re-throws unexpected errors', async () => {
    vi.mocked(contactRepo.linkPerson).mockRejectedValue(new Error('DB_CONNECTION_LOST'));

    await expect(server.call('link_contact_to_person', {
      contact_id: 'contact-1',
      person_id: 'person-abc',
    })).rejects.toThrow('DB_CONNECTION_LOST');
  });
});

describe('unlink_contact_from_person', () => {
  let server: ReturnType<typeof createMockServer>;
  let contactRepo: ContactRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    contactRepo = {
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      list: vi.fn(),
      resolve: vi.fn(),
      linkPerson: vi.fn(),
      unlinkPerson: vi.fn(),
    };

    const { registerUnlinkContactTool } = await import('../tools/link-contact.js');
    registerUnlinkContactTool(server as any, contactRepo, getUserId);
  });

  it('calls contactRepo.unlinkPerson with correct arguments', async () => {
    vi.mocked(contactRepo.unlinkPerson).mockResolvedValue(undefined);

    const result = await server.call('unlink_contact_from_person', {
      contact_id: 'contact-1',
    });

    expect(contactRepo.unlinkPerson).toHaveBeenCalledWith(USER_ID, 'contact-1');
    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
  });

  it('returns CONTACT_NOT_FOUND error when contact missing', async () => {
    vi.mocked(contactRepo.unlinkPerson).mockRejectedValue(new Error('CONTACT_NOT_FOUND'));

    const result = await server.call('unlink_contact_from_person', {
      contact_id: 'nonexistent',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('CONTACT_NOT_FOUND');
    expect((result as any).isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auto_match_contacts
// ---------------------------------------------------------------------------

describe('auto_match_contacts', () => {
  let server: ReturnType<typeof createMockServer>;
  let contactRepo: ContactRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();
    contactRepo = {
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      list: vi.fn(),
      resolve: vi.fn(),
      linkPerson: vi.fn(),
      unlinkPerson: vi.fn(),
    };

    const { registerAutoMatchContactsTool } = await import('../tools/auto-match-contacts.js');
    registerAutoMatchContactsTool(server as any, contactRepo, getUserId);
  });

  it('filters out groups and unnamed contacts', async () => {
    const contacts = [
      makeContact({ id: 'c1', display_name: 'Alice', is_group: false }),
      makeContact({ id: 'c2', display_name: null, is_group: false }),
      makeContact({ id: 'c3', display_name: 'Group Chat', is_group: true }),
      makeContact({ id: 'c4', display_name: 'Bob', is_group: false }),
    ];
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts, total: 4 });

    const result = await server.call('auto_match_contacts', {});
    const parsed = JSON.parse((result as any).content[0].text);

    // Only Alice and Bob should pass (have display_name, not a group)
    expect(parsed.unlinked_contacts).toHaveLength(2);
    expect(parsed.count).toBe(2);
    expect(parsed.unlinked_contacts[0].contact_name).toBe('Alice');
    expect(parsed.unlinked_contacts[1].contact_name).toBe('Bob');
  });

  it('queries for unlinked contacts only (hasPersonLink: false)', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('auto_match_contacts', {});

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      hasPersonLink: false,
    }));
  });

  it('respects platform filter', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('auto_match_contacts', { platform: 'telegram' });

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      platform: 'telegram',
    }));
  });

  it('uses default limit of 200', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    await server.call('auto_match_contacts', {});

    expect(contactRepo.list).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      limit: 200,
    }));
  });

  it('includes instructions for linking', async () => {
    vi.mocked(contactRepo.list).mockResolvedValue({ contacts: [], total: 0 });

    const result = await server.call('auto_match_contacts', {});
    const parsed = JSON.parse((result as any).content[0].text);

    expect(parsed.instructions).toContain('link_contact_to_person');
  });
});

// ---------------------------------------------------------------------------
// send_whatsapp
// ---------------------------------------------------------------------------

describe('send_whatsapp', () => {
  let server: ReturnType<typeof createMockServer>;
  let accountRepo: AccountRepository;
  let conversationRepo: ConversationRepository;
  const mockPool = {} as any;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();

    accountRepo = {
      listWhatsApp: vi.fn(),
      listTelegram: vi.fn(),
      getWhatsApp: vi.fn(),
      getTelegram: vi.fn(),
      findAccountPlatform: vi.fn(),
      updateStatus: vi.fn(),
      touchLastSeen: vi.fn(),
      getMessageCountToday: vi.fn(),
      logSentMessage: vi.fn(),
      createWhatsApp: vi.fn(),
    };

    conversationRepo = {
      list: vi.fn(),
      get: vi.fn(),
      upsert: vi.fn(),
      updatePermission: vi.fn(),
      touchLastMessage: vi.fn(),
    };

    const { registerSendWhatsAppTool } = await import('../tools/send-whatsapp.js');
    registerSendWhatsAppTool(server as any, accountRepo, conversationRepo, mockPool, getUserId);
  });

  it('returns ACCOUNT_NOT_FOUND when account does not exist', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(null);

    const result = await server.call('send_whatsapp', {
      account_id: 'nonexistent',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
    expect((result as any).isError).toBe(true);
  });

  it('returns ACCOUNT_DISCONNECTED when account is not connected', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(
      makeWhatsAppAccount({ status: 'disconnected' }),
    );

    const result = await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('ACCOUNT_DISCONNECTED');
  });

  it('returns PERMISSION_DENIED when priority is not agent', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('batch');

    const result = await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('PERMISSION_DENIED');
    expect(parsed.priority).toBe('batch');
  });

  it('returns PERMISSION_DENIED when no rule exists (null priority)', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue(null);

    const result = await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('PERMISSION_DENIED');
    expect(parsed.priority).toBe('no-rule');
  });

  it('sends message when priority is agent', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('agent');
    vi.mocked(conversationRepo.get).mockResolvedValue(makeConversation());
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-123' });

    const result = await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.message_id).toBe('msg-123');
  });

  it('appends @s.whatsapp.net to phone number for conversation lookup', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('agent');
    vi.mocked(conversationRepo.get).mockResolvedValue(null);
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-456' });

    await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    expect(mockGetConversationPriority).toHaveBeenCalledWith(
      mockPool, USER_ID, 'whatsapp', '972501234567@s.whatsapp.net',
    );
  });

  it('preserves existing JID suffix in to field', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('agent');
    vi.mocked(conversationRepo.get).mockResolvedValue(null);
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-789' });

    await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567@s.whatsapp.net',
      message: 'hello',
    });

    expect(mockGetConversationPriority).toHaveBeenCalledWith(
      mockPool, USER_ID, 'whatsapp', '972501234567@s.whatsapp.net',
    );
  });

  it('logs sent message after successful send', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('agent');
    vi.mocked(conversationRepo.get).mockResolvedValue(makeConversation());
    mockSendText.mockResolvedValue({ success: true, message_id: 'msg-log' });

    await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    expect(accountRepo.logSentMessage).toHaveBeenCalledWith(
      USER_ID, 'account-1', 'whatsapp', '972501234567', 'msg-log',
    );
  });

  it('returns SEND_FAILED when Evolution API returns failure', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockGetConversationPriority.mockResolvedValue('agent');
    vi.mocked(conversationRepo.get).mockResolvedValue(makeConversation());
    mockSendText.mockResolvedValue({ success: false, message_id: null });

    const result = await server.call('send_whatsapp', {
      account_id: 'account-1',
      to: '972501234567',
      message: 'hello',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('SEND_FAILED');
  });
});

// ---------------------------------------------------------------------------
// sync_whatsapp_conversations
// ---------------------------------------------------------------------------

describe('sync_whatsapp_conversations', () => {
  let server: ReturnType<typeof createMockServer>;
  let accountRepo: AccountRepository;
  let conversationRepo: ConversationRepository;
  let contactRepo: ContactRepository;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createMockServer();

    accountRepo = {
      listWhatsApp: vi.fn(),
      listTelegram: vi.fn(),
      getWhatsApp: vi.fn(),
      getTelegram: vi.fn(),
      findAccountPlatform: vi.fn(),
      updateStatus: vi.fn(),
      touchLastSeen: vi.fn(),
      getMessageCountToday: vi.fn(),
      logSentMessage: vi.fn(),
      createWhatsApp: vi.fn(),
    };

    conversationRepo = {
      list: vi.fn(),
      get: vi.fn(),
      upsert: vi.fn(),
      updatePermission: vi.fn(),
      touchLastMessage: vi.fn(),
    };

    contactRepo = {
      upsert: vi.fn(),
      bulkUpsert: vi.fn(),
      list: vi.fn(),
      resolve: vi.fn(),
      linkPerson: vi.fn(),
      unlinkPerson: vi.fn(),
    };

    const { registerSyncWhatsAppTool } = await import('../tools/sync-whatsapp.js');
    registerSyncWhatsAppTool(server as any, accountRepo, conversationRepo, contactRepo, getUserId);
  });

  it('returns ACCOUNT_NOT_FOUND when account does not exist', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(null);

    const result = await server.call('sync_whatsapp_conversations', {
      account_id: 'nonexistent',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('ACCOUNT_NOT_FOUND');
  });

  it('returns ACCOUNT_DISCONNECTED when account is not connected', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(
      makeWhatsAppAccount({ status: 'qr_pending' }),
    );

    const result = await server.call('sync_whatsapp_conversations', {
      account_id: 'account-1',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.error).toBe('ACCOUNT_DISCONNECTED');
  });

  it('upserts conversations and contacts from chats', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockFindChats.mockResolvedValue({
      chats: [
        { id: '972501234567@s.whatsapp.net', name: 'Alice', isGroup: false, isArchived: false, lastMessageTimestamp: 1700000000 },
        { id: '972509876543@s.whatsapp.net', name: 'Bob', isGroup: false, isArchived: false },
      ],
      contacts: [
        { remoteJid: '972501234567@s.whatsapp.net', pushName: 'Alice' },
      ],
    });
    vi.mocked(conversationRepo.upsert).mockResolvedValue({ created: true });
    vi.mocked(contactRepo.bulkUpsert).mockResolvedValue(2);
    vi.mocked(conversationRepo.list).mockResolvedValue({ conversations: [], total: 5 });

    const result = await server.call('sync_whatsapp_conversations', {
      account_id: 'account-1',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.total_conversations).toBe(5);
    expect(parsed.new_conversations).toBe(2);
    expect(contactRepo.bulkUpsert).toHaveBeenCalled();
  });

  it('counts new vs updated conversations correctly', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockFindChats.mockResolvedValue({
      chats: [
        { id: 'chat-1@s.whatsapp.net', name: 'New Chat', isGroup: false, isArchived: false },
        { id: 'chat-2@s.whatsapp.net', name: 'Existing Chat', isGroup: false, isArchived: false },
      ],
      contacts: [],
    });
    vi.mocked(conversationRepo.upsert)
      .mockResolvedValueOnce({ created: true })
      .mockResolvedValueOnce({ created: false });
    vi.mocked(contactRepo.bulkUpsert).mockResolvedValue(0);
    vi.mocked(conversationRepo.list).mockResolvedValue({ conversations: [], total: 10 });

    const result = await server.call('sync_whatsapp_conversations', {
      account_id: 'account-1',
    });

    const parsed = JSON.parse((result as any).content[0].text);
    expect(parsed.new_conversations).toBe(1);
    expect(parsed.updated_conversations).toBe(1);
  });

  it('updates last_message_at when timestamp provided', async () => {
    vi.mocked(accountRepo.getWhatsApp).mockResolvedValue(makeWhatsAppAccount());
    mockFindChats.mockResolvedValue({
      chats: [
        { id: 'chat-1@s.whatsapp.net', name: 'Chat', isGroup: false, isArchived: false, lastMessageTimestamp: 1700000000 },
      ],
      contacts: [],
    });
    vi.mocked(conversationRepo.upsert).mockResolvedValue({ created: true });
    vi.mocked(contactRepo.bulkUpsert).mockResolvedValue(0);
    vi.mocked(conversationRepo.list).mockResolvedValue({ conversations: [], total: 1 });

    await server.call('sync_whatsapp_conversations', { account_id: 'account-1' });

    expect(conversationRepo.touchLastMessage).toHaveBeenCalledWith(
      USER_ID, 'whatsapp', 'chat-1@s.whatsapp.net',
      new Date(1700000000 * 1000),
    );
  });
});
