import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Per-conversation outbound visibility (DECISION-020 one-sided-thread guard):
// query_im_messages must tell the agent which threads have their outbound side
// captured ("full") and which are inbound_only — where "you haven't replied"
// claims are ungrounded.
// ---------------------------------------------------------------------------

vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return { ...actual, logAudit: vi.fn() };
});

import { registerMessageTools } from '../tools/messages.js';
import { ElasticsearchMessageRepository } from '../repositories/elasticsearch/message.repository.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import type { MessageSearchResult } from '../types/message.js';
import type { Client } from '@elastic/elasticsearch';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

function makeMessageRepo(overrides: Partial<MessageRepository> = {}): MessageRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`MessageRepository.${name} not stubbed for this test`);
  });
  return {
    query: unimpl('query'),
    create: unimpl('create'),
    countActiveConversations: unimpl('countActiveConversations'),
    getConversationVisibility: unimpl('getConversationVisibility'),
    ...overrides,
  } as MessageRepository;
}

function msg(over: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return {
    id: 'msg-1',
    timestamp: '2026-07-02T10:00:00Z',
    sender: 'Alice',
    app: 'whatsapp',
    content: 'hi',
    conversation_id: 'whatsapp:alice',
    conversation_name: null,
    is_group: false,
    relevance_score: null,
    ...over,
  };
}

// ===========================================================================
// Tool envelope
// ===========================================================================

describe('query_im_messages conversation visibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks conversations "full" and adds no hint when every thread has outbound capture', async () => {
    const getConversationVisibility = vi.fn(async () => ({
      'whatsapp:alice': 'full' as const,
      'whatsapp:bob': 'full' as const,
    }));
    const repo = makeMessageRepo({
      query: vi.fn(async () => [
        msg({ id: 'm-1', conversation_id: 'whatsapp:alice' }),
        msg({ id: 'm-2', conversation_id: 'whatsapp:bob' }),
        msg({ id: 'm-3', conversation_id: 'whatsapp:alice' }), // dedup check
      ]),
      getConversationVisibility,
    });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    const response = await tools.get('query_im_messages')!({});
    const parsed = parseToolResponse<{
      messages: unknown[];
      total: number;
      conversations: Array<{ conversation_id: string; visibility: string }>;
      visibility_hint?: string;
    }>(response);

    // One batched call with the DEDUPED conversation ids — not one per message.
    expect(getConversationVisibility).toHaveBeenCalledTimes(1);
    expect(getConversationVisibility).toHaveBeenCalledWith(USER_ID, ['whatsapp:alice', 'whatsapp:bob']);

    expect(parsed.total).toBe(3);
    expect(parsed.conversations).toEqual([
      { conversation_id: 'whatsapp:alice', visibility: 'full' },
      { conversation_id: 'whatsapp:bob', visibility: 'full' },
    ]);
    expect(parsed.visibility_hint).toBeUndefined();
  });

  it('marks one-sided conversations "inbound_only" and includes the guard hint', async () => {
    const repo = makeMessageRepo({
      query: vi.fn(async () => [
        msg({ id: 'm-1', conversation_id: 'whatsapp:alice' }),
        msg({ id: 'm-2', conversation_id: 'slack:sitter' }),
      ]),
      getConversationVisibility: vi.fn(async () => ({
        'whatsapp:alice': 'full' as const,
        'slack:sitter': 'inbound_only' as const,
      })),
    });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    const response = await tools.get('query_im_messages')!({});
    const parsed = parseToolResponse<{
      conversations: Array<{ conversation_id: string; visibility: string }>;
      visibility_hint?: string;
    }>(response);

    expect(parsed.conversations).toEqual([
      { conversation_id: 'whatsapp:alice', visibility: 'full' },
      { conversation_id: 'slack:sitter', visibility: 'inbound_only' },
    ]);
    expect(parsed.visibility_hint).toBe(
      "Some threads are inbound_only: outbound side not captured for this thread — do NOT make 'you haven't replied / unanswered' claims about it.",
    );
  });

  it('skips the visibility lookup entirely when no message has a conversation_id', async () => {
    const getConversationVisibility = vi.fn();
    const repo = makeMessageRepo({
      query: vi.fn(async () => [msg({ conversation_id: null })]),
      getConversationVisibility: getConversationVisibility as never,
    });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    const response = await tools.get('query_im_messages')!({});
    const parsed = parseToolResponse<{ conversations: unknown[]; visibility_hint?: string }>(response);

    expect(getConversationVisibility).not.toHaveBeenCalled();
    expect(parsed.conversations).toEqual([]);
    expect(parsed.visibility_hint).toBeUndefined();
  });

  it('defaults a conversation missing from the visibility map to inbound_only (fail-safe)', async () => {
    const repo = makeMessageRepo({
      query: vi.fn(async () => [msg({ conversation_id: 'telegram:carol' })]),
      getConversationVisibility: vi.fn(async () => ({})),
    });
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));

    const response = await tools.get('query_im_messages')!({});
    const parsed = parseToolResponse<{ conversations: Array<{ visibility: string }>; visibility_hint?: string }>(response);

    expect(parsed.conversations[0].visibility).toBe('inbound_only');
    expect(parsed.visibility_hint).toBeDefined();
  });
});

// ===========================================================================
// Repository aggregation query
// ===========================================================================

describe('ElasticsearchMessageRepository.getConversationVisibility', () => {
  beforeEach(() => vi.clearAllMocks());

  function repoWithSearch(searchResponse: unknown) {
    const client = makeMockEsClient({
      search: vi.fn().mockResolvedValue(searchResponse),
    });
    return { repo: new ElasticsearchMessageRepository(client as unknown as Client), client };
  }

  it('runs ONE size-0 terms aggregation filtered to from_me within the trailing 30d window', async () => {
    const { repo, client } = repoWithSearch({
      hits: { hits: [], total: { value: 0, relation: 'eq' } },
      aggregations: { outbound_conversations: { buckets: [{ key: 'whatsapp:alice' }] } },
    });

    const result = await repo.getConversationVisibility(USER_ID, ['whatsapp:alice', 'slack:sitter']);

    expect(client.search).toHaveBeenCalledTimes(1);
    const body = (client.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.index).toBe('ll5_awareness_messages');
    expect(body.size).toBe(0);
    // user-scoped + batched terms filter + outbound + trailing window
    expect(body.query.bool.filter).toEqual(expect.arrayContaining([
      { term: { user_id: USER_ID } },
      { terms: { conversation_id: ['whatsapp:alice', 'slack:sitter'] } },
      { term: { from_me: true } },
      { range: { timestamp: { gte: 'now-30d' } } },
    ]));
    expect(body.aggs.outbound_conversations.terms).toEqual({
      field: 'conversation_id',
      size: 2,
    });

    expect(result).toEqual({
      'whatsapp:alice': 'full',
      'slack:sitter': 'inbound_only',
    });
  });

  it('honors a custom window', async () => {
    const { repo, client } = repoWithSearch({
      hits: { hits: [], total: { value: 0, relation: 'eq' } },
      aggregations: { outbound_conversations: { buckets: [] } },
    });

    await repo.getConversationVisibility(USER_ID, ['a'], 7);

    const body = (client.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(body.query.bool.filter).toEqual(expect.arrayContaining([
      { range: { timestamp: { gte: 'now-7d' } } },
    ]));
  });

  it('returns {} without querying ES when there are no conversation ids', async () => {
    const { repo, client } = repoWithSearch({});

    const result = await repo.getConversationVisibility(USER_ID, []);

    expect(result).toEqual({});
    expect(client.search).not.toHaveBeenCalled();
  });

  it('treats a response with no aggregations as all inbound_only', async () => {
    const { repo } = repoWithSearch({ hits: { hits: [], total: { value: 0, relation: 'eq' } } });

    const result = await repo.getConversationVisibility(USER_ID, ['x', 'y']);

    expect(result).toEqual({ x: 'inbound_only', y: 'inbound_only' });
  });
});
