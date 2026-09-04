import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Partial mock: keep the real cap/cursor helpers + formatTime, silence the audit ES write.
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return { ...actual, logAudit: vi.fn() };
});

import { decodeCursor, encodeCursor, formatTime, sessionTimezone, MCP_RESULT_CAP_CHARS } from '@ll5/shared';
import { registerJournalTools } from '../tools/journal.js';
import { registerRecallEverythingTool } from '../tools/recall-everything.js';
import { registerMessageTools } from '../tools/messages.js';
import { registerLessonTools } from '../tools/lessons.js';
import { registerMediaTools } from '../tools/media.js';
import { captureTools, parseToolResponse, makeMockEsClient, type ToolHandler } from './_helpers.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';

const USER_ID = 'user-cap-1';
const getUserId = () => USER_ID;

/** Like captureTools, but also keeps the Zod shape so a test can run the real input validation. */
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
const validate = (t: { schema: Record<string, z.ZodTypeAny> }, input: unknown) => z.object(t.schema).safeParse(input);

// ---------------------------------------------------------------------------
// read_journal
// ---------------------------------------------------------------------------
describe('read_journal — ISS-019 cap + cursor', () => {
  const journalHit = (i: number) => ({
    _id: `j${i}`,
    _source: {
      user_id: USER_ID,
      type: 'observation',
      topic: `topic-${i}`,
      content: `${i}:` + 'x'.repeat(900),
      status: 'open',
      created_at: `2026-08-${String(30 - (i % 28)).padStart(2, '0')}T10:00:00Z`,
      updated_at: '2026-08-30T10:00:00Z',
    },
  });
  const ALL = Array.from({ length: 100 }, (_, i) => journalHit(i));

  /** ES mock that honours from/size like the real index would. */
  function esPaged(total = ALL.length) {
    return makeMockEsClient({
      search: vi.fn(async (req: { from?: number; size?: number }) => ({
        hits: { total: { value: total, relation: 'eq' }, hits: ALL.slice(req.from ?? 0, (req.from ?? 0) + (req.size ?? 20)) },
      })),
    });
  }

  it('caps a 100-entry page at ~20 KB, at entry boundaries, newest first, with next_cursor + hint', async () => {
    const es = esPaged();
    const tools = captureTools((s) => registerJournalTools(s, es as never, getUserId));
    const res = await tools.get('read_journal')!({ status: 'open', limit: 100 });
    const text = res.content[0].text;
    expect(text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);

    const out = parseToolResponse<{ entries: Array<{ id: string; content: string }>; total: number; matched: number; truncated?: boolean; next_cursor?: string; hint?: string }>(res);
    expect(out.entries.length).toBeGreaterThan(5);
    expect(out.entries.length).toBeLessThan(100);
    // item boundary: every returned entry is whole
    for (const e of out.entries) expect(e.content.length).toBeGreaterThan(900);
    expect(out.entries[0].id).toBe('j0');
    expect(out.total).toBe(out.entries.length);
    expect(out.matched).toBe(100);
    expect(out.truncated).toBe(true);
    expect(decodeCursor(out.next_cursor)).toBe(out.entries.length);
    expect(out.hint).toMatch(/since/);

    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.from).toBe(0);
    expect(call.track_total_hits).toBe(true);
    expect(call.query.bool.must[0]).toEqual({ term: { user_id: USER_ID } });
  });

  it('page 2 via cursor continues exactly where page 1 stopped', async () => {
    const es = esPaged();
    const tools = captureTools((s) => registerJournalTools(s, es as never, getUserId));
    const p1 = parseToolResponse<{ entries: Array<{ id: string }>; next_cursor: string }>(
      await tools.get('read_journal')!({ limit: 100 }),
    );
    const p2 = parseToolResponse<{ entries: Array<{ id: string }>; next_cursor?: string }>(
      await tools.get('read_journal')!({ limit: 100, cursor: p1.next_cursor }),
    );
    const call2 = (es.search as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(call2.from).toBe(p1.entries.length);
    expect(p2.entries[0].id).toBe(`j${p1.entries.length}`);
    const ids = [...p1.entries, ...p2.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a small result is byte-identical to the pre-cap envelope (no page fields)', async () => {
    const hits = [journalHit(0), journalHit(1)].map((h) => ({ ...h, _source: { ...h._source, content: 'short' } }));
    const es = makeMockEsClient({ search: vi.fn().mockResolvedValue({ hits: { total: { value: 2 }, hits } }) });
    const tools = captureTools((s) => registerJournalTools(s, es as never, getUserId));
    const res = await tools.get('read_journal')!({});
    const tz = sessionTimezone();
    const expected = JSON.stringify({
      entries: hits.map((h) => ({
        id: h._id,
        ...h._source,
        created_at_local: formatTime(h._source.created_at, tz).local,
        updated_at_local: formatTime(h._source.updated_at, tz).local,
      })),
      total: 2,
      tz,
    });
    expect(res.content[0].text).toBe(expected);
  });

  it('rejects a garbage cursor with a structured error instead of restarting from the top', async () => {
    const es = esPaged();
    const tools = captureTools((s) => registerJournalTools(s, es as never, getUserId));
    const res = await tools.get('read_journal')!({ cursor: 'nope' });
    expect(res.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(res).error).toMatch(/Invalid cursor/);
    expect(es.search).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// write_journal — ISS-021 signal enum
// ---------------------------------------------------------------------------
describe('write_journal — ISS-021 schema', () => {
  it('accepts signal "consolidated" (consolidate skill) and "completed" (backfill skill)', () => {
    const tools = captureWithSchemas((s) => registerJournalTools(s, makeMockEsClient() as never, getUserId));
    const wj = tools.get('write_journal')!;
    expect(validate(wj, { type: 'observation', topic: 't', content: 'c', signal: 'consolidated' }).success).toBe(true);
    expect(validate(wj, { type: 'commitment', topic: 't', content: 'c', signal: 'completed' }).success).toBe(true);
    // type stays strict — "confirmed" is a signal, not a type (agent slip, not a contract gap)
    expect(validate(wj, { type: 'confirmed', topic: 't', content: 'c', signal: 'confirmed' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// recall_everything
// ---------------------------------------------------------------------------
describe('recall_everything — ISS-019 cap + cursor + session body stripping', () => {
  function esReturning(hits: unknown[]) {
    return makeMockEsClient({ search: vi.fn().mockResolvedValue({ hits: { hits } }) });
  }

  it('never inlines a session transcript: messages/transcript_text are replaced by their sizes', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({ role: 'user', text: `m${i} ` + 'y'.repeat(2000) }));
    const es = esReturning([
      {
        _index: 'll5_session_history',
        _id: 's1',
        _score: 3,
        _source: { session_id: 's1', user_id: USER_ID, message_count: 30, last_message: '2026-08-27T10:00:00Z', messages, transcript_text: 'z'.repeat(100_000) },
      },
      { _index: 'll5_knowledge_facts', _id: 'f1', _score: 2, _source: { content: 'Ivgi installs the pergola' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'Ivgi', mode: 'timeline', all_sessions: true });
    expect(res.content[0].text.length).toBeLessThan(MCP_RESULT_CAP_CHARS);
    const out = parseToolResponse<{ results: Array<{ source: string; data: Record<string, unknown> }>; truncated?: boolean }>(res);
    const session = out.results.find((r) => r.source === 'session')!;
    expect(session.data.messages).toBeUndefined();
    expect(session.data.transcript_text).toBeUndefined();
    expect(session.data.message_count).toBe(30);
    expect(session.data.transcript_chars).toBe(100_000);
    // the small distilled doc is untouched
    expect(out.results.find((r) => r.source === 'fact')!.data.content).toBe('Ivgi installs the pergola');
    expect(out.truncated).toBeUndefined();
  });

  it('caps a long timeline page at item boundaries and pages via cursor', async () => {
    const hits = Array.from({ length: 80 }, (_, i) => ({
      _index: 'll5_agent_journal',
      _id: `j${i}`,
      _score: 1,
      _source: { topic: 'glasses', content: `${i}:` + 'x'.repeat(900), created_at: new Date(Date.UTC(2026, 7, 30) - i * 3_600_000).toISOString() },
    }));
    const es = esReturning(hits);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const p1 = await tools.get('recall_everything')!({ query: 'glasses', mode: 'timeline', limit: 80 });
    expect(p1.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const o1 = parseToolResponse<{ results: Array<{ id: string; data: { content: string } }>; total: number; truncated: boolean; next_cursor: string; hint: string }>(p1);
    expect(o1.results.length).toBeLessThan(80);
    expect(o1.results[0].id).toBe('j0'); // most recent first
    for (const r of o1.results) expect(r.data.content.length).toBeGreaterThan(900);
    expect(o1.total).toBe(o1.results.length);
    expect(o1.truncated).toBe(true);
    expect(o1.hint).toMatch(/sources/);
    expect(decodeCursor(o1.next_cursor)).toBe(o1.results.length);

    const p2 = parseToolResponse<{ results: Array<{ id: string }> }>(
      await tools.get('recall_everything')!({ query: 'glasses', mode: 'timeline', limit: 80, cursor: o1.next_cursor }),
    );
    expect(p2.results[0].id).toBe(`j${o1.results.length}`);
  });

  it('small result carries no page fields (pre-cap envelope keys only)', async () => {
    const es = esReturning([{ _index: 'll5_knowledge_facts', _id: 'f1', _score: 2, _source: { content: 'Rotem is the wife' } }]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const out = parseToolResponse<Record<string, unknown>>(await tools.get('recall_everything')!({ query: 'Rotem' }));
    expect(out.truncated).toBeUndefined();
    expect(out.next_cursor).toBeUndefined();
    expect(Object.keys(out)).toEqual(['query', 'mode', 'session_window', 'coverage', 'total', 'by_source', 'results', 'suggest_postgres', 'suggest_widen_sessions', 'note']);
  });
});

// ---------------------------------------------------------------------------
// query_im_messages
// ---------------------------------------------------------------------------
describe('query_im_messages — ISS-019 cap + cursor', () => {
  const msg = (i: number) => ({
    id: `m${i}`,
    timestamp: new Date(Date.UTC(2026, 8, 3) - i * 60_000).toISOString(),
    sender: i % 2 ? 'Adi' : 'Arnon',
    app: 'whatsapp',
    content: `${i}:` + 'x'.repeat(900),
    conversation_id: `conv-${i % 3}`,
    conversation_name: null,
    is_group: false,
    relevance_score: null,
  });
  const ALL = Array.from({ length: 200 }, (_, i) => msg(i));

  function repoPaged(): MessageRepository & { query: ReturnType<typeof vi.fn> } {
    return {
      query: vi.fn(async (_u: string, p: { limit?: number; offset?: number }) => ALL.slice(p.offset ?? 0, (p.offset ?? 0) + (p.limit ?? 50))),
      getConversationVisibility: vi.fn(async (_u: string, ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'full' as const]))),
    } as unknown as MessageRepository & { query: ReturnType<typeof vi.fn> };
  }

  it('caps at message boundaries; conversations reflect only the shown page; next_cursor round-trips', async () => {
    const repo = repoPaged();
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));
    const p1 = await tools.get('query_im_messages')!({ conversation_id: 'x', limit: 100 });
    expect(p1.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const o1 = parseToolResponse<{ messages: Array<{ id: string; content: string }>; total: number; conversations: unknown[]; truncated: boolean; next_cursor: string; hint: string }>(p1);
    expect(repo.query.mock.calls[0][0]).toBe(USER_ID);
    expect(repo.query.mock.calls[0][1].limit).toBe(101);
    expect(o1.messages.length).toBeLessThan(100);
    expect(o1.messages[0].id).toBe('m0');
    for (const m of o1.messages) expect(m.content.length).toBeGreaterThan(900);
    expect(o1.total).toBe(o1.messages.length);
    expect(o1.truncated).toBe(true);
    expect(o1.hint).toMatch(/conversation_id/);
    const shownConvs = new Set(o1.messages.map((m) => (ALL.find((a) => a.id === m.id)!).conversation_id));
    expect(o1.conversations.length).toBe(shownConvs.size);

    const p2 = parseToolResponse<{ messages: Array<{ id: string }> }>(
      await tools.get('query_im_messages')!({ conversation_id: 'x', limit: 100, cursor: o1.next_cursor }),
    );
    expect(repo.query.mock.calls[1][1].offset).toBe(o1.messages.length);
    expect(p2.messages[0].id).toBe(`m${o1.messages.length}`);
  });

  it('exactly-full page with no more rows is NOT marked truncated (probe row absent)', async () => {
    const repo = { query: vi.fn(async () => ALL.slice(0, 3)), getConversationVisibility: vi.fn(async () => ({})) } as unknown as MessageRepository;
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));
    const out = parseToolResponse<Record<string, unknown>>(await tools.get('query_im_messages')!({ limit: 3 }));
    expect(out.truncated).toBeUndefined();
    expect((out.messages as unknown[]).length).toBe(3);
  });

  it('small result keeps the pre-cap envelope keys', async () => {
    const repo = { query: vi.fn(async () => [msg(0), msg(1)].map((m) => ({ ...m, content: 'hi' }))), getConversationVisibility: vi.fn(async () => ({ 'conv-0': 'full', 'conv-1': 'full' })) } as unknown as MessageRepository;
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));
    const out = parseToolResponse<Record<string, unknown>>(await tools.get('query_im_messages')!({}));
    expect(Object.keys(out)).toEqual(['messages', 'total', 'conversations']);
  });

  it('accepts a cursor produced by encodeCursor and forwards the offset', async () => {
    const repo = repoPaged();
    const tools = captureTools((s) => registerMessageTools(s, repo, getUserId));
    await tools.get('query_im_messages')!({ limit: 5, cursor: encodeCursor(40) });
    expect(repo.query.mock.calls[0][1]).toMatchObject({ limit: 6, offset: 40 });
  });
});

// ---------------------------------------------------------------------------
// upsert_lesson — ISS-021 `content` alias + defaults
// ---------------------------------------------------------------------------
describe('upsert_lesson — ISS-021 content alias', () => {
  it('a bare `content` body becomes claim (first line) + detail, trigger + durability default, defaults echoed', async () => {
    const es = makeMockEsClient({ search: vi.fn().mockResolvedValue({ hits: { hits: [] } }) });
    const tools = captureWithSchemas((s) => registerLessonTools(s, es as never, getUserId));
    const t = tools.get('upsert_lesson')!;
    const content =
      '**When surfacing a 1:1 thread from a batch review, ALWAYS check both sides via `query_im_messages`.**\n\n' +
      'The batch-review event shows the INBOUND side only.\n\nHow to apply:\n1. read both sides.';
    expect(validate(t, { content }).success).toBe(true);

    const out = parseToolResponse<{ ok: boolean; durability: string; defaults_applied: Record<string, string> }>(await t.handler({ content }));
    expect(out.ok).toBe(true);
    expect(out.durability).toBe('durable');
    expect(out.defaults_applied).toEqual({ claim: 'first line of content', detail: 'content', trigger: 'claim', durability: 'durable' });

    const doc = (es.index as ReturnType<typeof vi.fn>).mock.calls[0][0].document;
    expect(doc.claim).toBe('When surfacing a 1:1 thread from a batch review, ALWAYS check both sides via `query_im_messages`.');
    expect(doc.trigger).toBe(doc.claim);
    expect(doc.detail).toBe(content);
    expect(doc.author_user_id).toBe(USER_ID);
  });

  it('neither claim nor content → structured error, nothing written', async () => {
    const es = makeMockEsClient();
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const out = parseToolResponse<{ ok: boolean; error: string }>(await tools.get('upsert_lesson')!({ trigger: 't' }));
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/claim/);
    expect(es.index).not.toHaveBeenCalled();
  });

  it('explicit claim/trigger/durability are unchanged and echo no defaults', async () => {
    const es = makeMockEsClient({ search: vi.fn().mockResolvedValue({ hits: { hits: [] } }) });
    const tools = captureTools((s) => registerLessonTools(s, es as never, getUserId));
    const out = parseToolResponse<Record<string, unknown>>(
      await tools.get('upsert_lesson')!({ claim: 'c', trigger: 't', durability: 'durable' }),
    );
    expect(out.ok).toBe(true);
    expect(out.defaults_applied).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// link_media — ISS-021 link_type / link_id aliases
// ---------------------------------------------------------------------------
describe('link_media — ISS-021 aliases', () => {
  it('accepts the live payload shape (link_kind/link_type/link_id) and links by entity_type/entity_id', async () => {
    const es = makeMockEsClient({ get: vi.fn().mockResolvedValue({ _id: 'media-1', _source: { user_id: USER_ID } }) });
    const tools = captureWithSchemas((s) => registerMediaTools(s, es as never, getUserId));
    const t = tools.get('link_media')!;
    const live = { media_id: 'NucZbKABbql6i614JTjL', link_kind: 'measurement', link_type: 'journal_topic', link_id: 'arnon-fever-trajectory' };
    expect(validate(t, live).success).toBe(true);

    const out = parseToolResponse<{ linked: boolean }>(await t.handler(live));
    expect(out.linked).toBe(true);
    const call = (es.index as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.id).toBe('NucZbKABbql6i614JTjL_journal_topic_arnon-fever-trajectory');
    expect(call.document).toMatchObject({ user_id: USER_ID, entity_type: 'journal_topic', entity_id: 'arnon-fever-trajectory' });
  });

  it('no target at all → structured error, nothing written', async () => {
    const es = makeMockEsClient();
    const tools = captureTools((s) => registerMediaTools(s, es as never, getUserId));
    const res = await tools.get('link_media')!({ media_id: 'm' });
    expect(res.isError).toBe(true);
    expect(es.index).not.toHaveBeenCalled();
  });
});
