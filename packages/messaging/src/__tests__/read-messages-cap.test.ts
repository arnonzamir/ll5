import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { decodeCursor, MCP_RESULT_CAP_CHARS, sessionTimezone } from '@ll5/shared';
import { captureTools, parseToolResponse, type ToolHandler } from './_helpers.js';
import { registerReadMessagesTool } from '../tools/read-messages.js';
import type { AccountRepository, WhatsAppAccountRecord } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository, ConversationRecord } from '../repositories/interfaces/conversation.repository.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Evolution is the external boundary: capture the limit the tool asks for and
// return that many raw messages (like the real /chat/findMessages would).
const mockFetchMessages = vi.fn();
vi.mock('../clients/evolution.client.js', () => ({
  EvolutionClient: class {
    constructor() {}
    fetchMessages = mockFetchMessages;
  },
}));

const USER_ID = 'user-1';
const getUserId = () => USER_ID;
const CHAT = '972500000000@s.whatsapp.net';

function rawMessage(i: number, size = 900) {
  return {
    key: { id: `wa-${i}`, fromMe: i % 2 === 0, remoteJid: CHAT },
    pushName: i % 2 === 0 ? 'Me' : 'Adi',
    message: { conversation: `${i}:` + 'x'.repeat(size) },
    messageTimestamp: 1_756_800_000 - i * 60,
  };
}

function makeAccountRepo(): AccountRepository {
  return {
    getWhatsApp: vi.fn(async () => ({
      id: 'wa-account-1', user_id: USER_ID, instance_name: 'll5', instance_id: 'i', api_url: 'http://evo', api_key: 'k',
      phone_number: null, status: 'connected', last_error: null, last_seen_at: null, created_at: new Date(), updated_at: new Date(),
    }) as WhatsAppAccountRecord),
    getTelegram: vi.fn(async () => null),
  } as unknown as AccountRepository;
}
function makeConversationRepo(): ConversationRepository {
  return {
    get: vi.fn(async () => ({ account_id: 'wa-account-1', platform: 'whatsapp', conversation_id: CHAT, name: 'Adi', is_group: false }) as unknown as ConversationRecord),
  } as unknown as ConversationRepository;
}
function makeMockPool(): Pool {
  return { query: vi.fn(async () => ({ rows: [{ permission: 'agent' }], rowCount: 1 })) } as unknown as Pool;
}

function captureWithSchemas(register: (s: McpServer) => void) {
  const tools = new Map<string, { schema: Record<string, z.ZodTypeAny>; handler: ToolHandler }>();
  const fake = {
    tool: (name: string, _d: string, schema: Record<string, z.ZodTypeAny>, handler: ToolHandler) => {
      tools.set(name, { schema, handler });
    },
  } as unknown as McpServer;
  register(fake);
  return tools;
}

function setup() {
  return captureTools((s) => registerReadMessagesTool(s, makeAccountRepo(), makeConversationRepo(), makeMockPool(), getUserId));
}

describe('read_messages — ISS-021 unsupported platform redirect', () => {
  beforeEach(() => mockFetchMessages.mockReset());

  it('the live "slack" payload passes input validation and gets an actionable redirect to query_im_messages', async () => {
    const tools = captureWithSchemas((s) => registerReadMessagesTool(s, makeAccountRepo(), makeConversationRepo(), makeMockPool(), getUserId));
    const t = tools.get('read_messages')!;
    const live = { platform: 'slack', conversation_id: 'slack:group:ext-loanpro-sunbit', limit: 10 };
    expect(z.object(t.schema).safeParse(live).success).toBe(true);

    const res = await t.handler(live);
    expect(res.isError).toBe(true);
    const body = parseToolResponse<{ error: string; supported: string[]; hint: string }>(res);
    expect(body.error).toBe('UNSUPPORTED_PLATFORM');
    expect(body.supported).toEqual(['whatsapp', 'telegram']);
    expect(body.hint).toContain('query_im_messages({ app: "slack", conversation_id: "slack:group:ext-loanpro-sunbit", limit: 10 })');
    expect(mockFetchMessages).not.toHaveBeenCalled();
  });
});

describe('read_messages — ISS-019 cap + cursor (WhatsApp)', () => {
  beforeEach(() => {
    mockFetchMessages.mockReset();
    mockFetchMessages.mockImplementation(async (_chat: string, limit: number) => Array.from({ length: limit }, (_, i) => rawMessage(i)));
  });

  it('fetches limit+1 (probe), caps at message boundaries, reports next_cursor + hint', async () => {
    const tools = setup();
    const res = await tools.get('read_messages')!({ platform: 'whatsapp', conversation_id: CHAT, limit: 60 });
    expect(mockFetchMessages).toHaveBeenCalledWith(CHAT, 61);
    expect(res.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const out = parseToolResponse<{ messages: Array<{ message_id: string; content: string }>; tz: string; truncated: boolean; next_cursor: string; hint: string }>(res);
    expect(out.messages.length).toBeLessThan(60);
    expect(out.messages[0].message_id).toBe('wa-0');
    for (const m of out.messages) expect(m.content.length).toBeGreaterThan(900);
    expect(out.truncated).toBe(true);
    expect(out.hint).toMatch(/since/);
    expect(decodeCursor(out.next_cursor)).toBe(out.messages.length);
  });

  it('page 2 via cursor fetches through the page and continues where page 1 stopped', async () => {
    const tools = setup();
    const p1 = parseToolResponse<{ messages: Array<{ message_id: string }>; next_cursor: string }>(
      await tools.get('read_messages')!({ platform: 'whatsapp', conversation_id: CHAT, limit: 60 }),
    );
    const n = p1.messages.length;
    const p2 = parseToolResponse<{ messages: Array<{ message_id: string }> }>(
      await tools.get('read_messages')!({ platform: 'whatsapp', conversation_id: CHAT, limit: 60, cursor: p1.next_cursor }),
    );
    expect(mockFetchMessages).toHaveBeenLastCalledWith(CHAT, n + 60 + 1);
    expect(p2.messages[0].message_id).toBe(`wa-${n}`);
  });

  it('small result is byte-identical to the pre-cap (pretty-printed) envelope', async () => {
    mockFetchMessages.mockImplementation(async () => [rawMessage(0, 3), rawMessage(1, 3)]);
    const tools = setup();
    const res = await tools.get('read_messages')!({ platform: 'whatsapp', conversation_id: CHAT });
    expect(mockFetchMessages).toHaveBeenCalledWith(CHAT, 21);
    const parsed = JSON.parse(res.content[0].text) as { messages: unknown[]; tz: string };
    expect(Object.keys(parsed)).toEqual(['messages', 'tz']);
    expect(parsed.messages).toHaveLength(2);
    expect(res.content[0].text).toBe(JSON.stringify({ messages: parsed.messages, tz: sessionTimezone() }, null, 2));
  });

  it('platform is case-insensitive ("WhatsApp")', async () => {
    mockFetchMessages.mockImplementation(async () => [rawMessage(0, 3)]);
    const tools = setup();
    const res = await tools.get('read_messages')!({ platform: 'WhatsApp', conversation_id: CHAT });
    expect(res.isError).toBeUndefined();
    expect(mockFetchMessages).toHaveBeenCalledTimes(1);
  });
});
