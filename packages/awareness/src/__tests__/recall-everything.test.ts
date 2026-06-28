import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerRecallEverythingTool } from '../tools/recall-everything.js';
import { captureTools, parseToolResponse, makeMockEsClient } from './_helpers.js';

const getUserId = () => 'user-1';

interface Hit {
  _index: string;
  _id: string;
  _score: number;
  _source: Record<string, unknown>;
  highlight?: Record<string, string[]>;
}

function esReturning(hits: Hit[], byIndexAgg?: Array<{ key: string; doc_count: number }>) {
  return makeMockEsClient({
    search: vi.fn().mockResolvedValue({
      hits: { hits },
      ...(byIndexAgg ? { aggregations: { by_index: { buckets: byIndexAgg } } } : {}),
    }),
  });
}

interface Resp {
  query: string;
  coverage: 'rich' | 'thin' | 'empty';
  total: number;
  by_source: Record<string, number>;
  results: Array<{ source: string; id: string; score: number; summary: string; highlight: string | null }>;
  suggest_postgres?: string[];
  suggest_sessions?: boolean;
  note?: string;
}

describe('recall_everything — unified cross-store sweep', () => {
  // Pin "now" far past the fixture dates so the recency bonus is ~0 for all of them —
  // the default-rank order then reduces to pure relevance (what the order tests assert).
  // The dedicated recency test below moves "now" next to its fixtures.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2030-06-01T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('recency-weighted default lifts a fresh hit above a higher-scoring stale one', async () => {
    vi.setSystemTime(new Date('2026-06-20T12:00:00Z'));
    const es = esReturning([
      { _index: 'll5_agent_journal', _id: 'stale', _score: 10, _source: { topic: 't', content: 'old but term-dense match match match', created_at: '2026-05-01T00:00:00Z' } },
      { _index: 'll5_agent_journal', _id: 'fresh', _score: 8, _source: { topic: 't', content: 'recent note', created_at: '2026-06-19T00:00:00Z' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'match' });
    const out = parseToolResponse<Resp>(res);
    // fresh (1 day old, recency ~1) leads despite a lower BM25 score than the 50-day-old hit
    expect(out.results[0].id).toBe('fresh');
    expect(out.results[1].id).toBe('stale');
  });

  it('groups hits by source, ranks by score, reports rich coverage', async () => {
    const es = esReturning([
      { _index: 'll5_knowledge_facts', _id: 'f1', _score: 9, _source: { content: 'Rotem is the wife' } },
      { _index: 'll5_agent_journal', _id: 'j1', _score: 7, _source: { topic: 'calendar', content: 'event X is Rotem\'s, not mine' } },
      { _index: 'll5_awareness_calendar_events', _id: 'c1', _score: 5, _source: { title: 'פגישה', start_time: '2026-06-20T20:00:00Z', calendar_name: 'shared' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'Rotem event' });
    const out = parseToolResponse<Resp>(res);

    expect(out.coverage).toBe('rich');
    expect(out.total).toBe(3);
    expect(out.by_source).toEqual({ fact: 1, journal: 1, calendar: 1 });
    // ranked by score descending
    expect(out.results.map((r) => r.source)).toEqual(['fact', 'journal', 'calendar']);
    // no postgres hint when coverage is rich
    expect(out.suggest_postgres).toBeUndefined();
  });

  it('closes the journal gap: matches on journal CONTENT, not just topic, and summarizes it', async () => {
    const es = esReturning([
      { _index: 'll5_agent_journal', _id: 'j1', _score: 4, _source: { topic: 'misc', content: 'advisors movie meeting belongs to Rotem' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'advisors movie' });
    const out = parseToolResponse<Resp>(res);
    expect(out.results[0].source).toBe('journal');
    expect(out.results[0].summary).toContain('advisors movie meeting belongs to Rotem');
  });

  it('empty result → coverage empty + Postgres escalation hint', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'nothing here' });
    const out = parseToolResponse<Resp>(res);
    expect(out.coverage).toBe('empty');
    expect(out.total).toBe(0);
    expect(out.suggest_postgres).toEqual(['gtd', 'gmail']);
    expect(out.note).toContain('gtd');
  });

  it('thin result (below threshold) → coverage thin + escalation hint', async () => {
    const es = esReturning([
      { _index: 'll5_knowledge_people', _id: 'p1', _score: 3, _source: { name: 'Dana', relationship: 'colleague' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'Dana' });
    const out = parseToolResponse<Resp>(res);
    expect(out.coverage).toBe('thin');
    expect(out.suggest_postgres).toEqual(['gtd', 'gmail']);
    expect(out.results[0].summary).toContain('Dana');
  });

  it('per_source_cap stops one chatty store from drowning the rest', async () => {
    const many: Hit[] = Array.from({ length: 10 }, (_, i) => ({
      _index: 'll5_awareness_messages',
      _id: `m${i}`,
      _score: 10 - i,
      _source: { sender: 'X', content: `msg ${i}` },
    }));
    const es = esReturning(many);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'msg', per_source_cap: 2 });
    const out = parseToolResponse<Resp>(res);
    expect(out.by_source.message).toBe(2);
    expect(out.total).toBe(2);
  });

  it('scopes by user_id and admits world-scoped lessons via _index', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'anything' });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const should = call.query.bool.filter[0].bool.should;
    expect(should).toContainEqual({ term: { user_id: 'user-1' } });
    expect(should).toContainEqual({ term: { _index: 'll5_agent_lessons' } });
    // retired lessons excluded
    expect(call.query.bool.must_not).toContainEqual({ term: { status: 'retired' } });
  });

  it('sources filter restricts the indices actually queried', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'q', sources: ['journal', 'calendar'] });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_agent_journal,ll5_awareness_calendar_events');
  });

  it('rejects an unknown source label with the valid set (incl. session)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'q', sources: ['bogus'] });
    const out = parseToolResponse<{ error: string; valid_sources: string[] }>(res);
    expect(out.error).toContain('No matching sources');
    expect(out.valid_sources).toContain('journal');
    expect(out.valid_sources).toContain('session');
    expect(es.search).not.toHaveBeenCalled();
  });

  it('sweeps session history by DEFAULT, time-bounded to the recent window (7d)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'q' });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toContain('ll5_session_history');
    // a session time-bound is present (range on last_message, default 7d)
    expect(JSON.stringify(call.query.bool.filter)).toContain('now-7d');
    const should = call.query.bool.filter[0].bool.should;
    expect(should).toContainEqual({ term: { 'user_id.keyword': 'user-1' } });
  });

  it('session_days widens the session window; all_sessions removes the bound', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'q', session_days: 30 });
    const c1 = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(c1.query.bool.filter)).toContain('now-30d');

    const es2 = esReturning([]);
    const tools2 = captureTools((s) => registerRecallEverythingTool(s, es2 as never, getUserId));
    await tools2.get('recall_everything')!({ query: 'q', all_sessions: true });
    const c2 = (es2.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(c2.index).toContain('ll5_session_history');
    expect(JSON.stringify(c2.query.bool.filter)).not.toContain('now-'); // no time bound
  });

  it('empty query → match_all (read back the recent window)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: '', mode: 'timeline' });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.query.bool.must[0]).toEqual({ match_all: {} });
  });

  it('thin default sweep nudges WIDENING sessions (they are already searched)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'q' });
    const out = parseToolResponse<Resp & { suggest_widen_sessions?: boolean }>(res);
    expect(out.suggest_widen_sessions).toBe(true);
    expect(out.note).toContain('all_sessions');
  });

  it('session floor: surfaces a recent session even when out-scored out of the main fetch', async () => {
    const search = vi.fn()
      // main sweep: only a high-scoring journal hit, no session in the window
      .mockResolvedValueOnce({ hits: { hits: [{ _index: 'll5_agent_journal', _id: 'j1', _score: 50, _source: { topic: 't', content: 'server stuff' } }] } })
      // dedicated session floor fetch returns the relevant recent session
      .mockResolvedValueOnce({ hits: { hits: [{ _index: 'll5_session_history', _id: 's9', _score: 2, _source: { message_count: 80, last_message: '2026-06-28T06:00:00Z', transcript_text: 'about server-coolify' }, highlight: { transcript_text: ['about <em>server-coolify</em>'] } }] } });
    const es = makeMockEsClient({ search });
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'server-coolify' });
    const out = parseToolResponse<Resp>(res);
    expect(es.search).toHaveBeenCalledTimes(2); // main + floor
    expect(out.by_source.session).toBe(1);
    expect(out.results.some((r) => r.source === 'session' && r.id === 's9')).toBe(true);
  });

  it('recent_sessions returns a compact 7d map with the opener line', async () => {
    const es = makeMockEsClient({ search: vi.fn().mockResolvedValue({ hits: { hits: [
      { _index: 'll5_session_history', _id: 's1', _source: { session_id: 'sid1', first_message: '2026-06-27T10:00:00Z', last_message: '2026-06-27T11:00:00Z', message_count: 12, messages: [{ role: 'human', text: '  what about the trip\n plans' }, { role: 'assistant', text: '...' }] } },
    ] } }) });
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recent_sessions')!({ days: 7 });
    const out = parseToolResponse<{ days: number; total: number; sessions: Array<{ session_id: string; opener: string; messages: number }> }>(res);
    expect(out.total).toBe(1);
    expect(out.sessions[0].session_id).toBe('sid1');
    expect(out.sessions[0].opener).toBe('what about the trip plans');
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(call.query.bool.filter)).toContain('now-7d');
  });

  it('opt-in: sources:["session"] adds ll5_session_history and summarizes a transcript hit', async () => {
    const es = esReturning([
      {
        _index: 'll5_session_history',
        _id: 's1',
        _score: 6,
        _source: { message_count: 42, last_message: '2026-06-20T18:00:00Z', transcript_text: 'about the advisors movie' },
        highlight: { transcript_text: ['about the <em>advisors movie</em>'] },
      },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'advisors movie', sources: ['session'] });
    const out = parseToolResponse<Resp>(res);
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).toBe('ll5_session_history');
    expect(out.by_source.session).toBe(1);
    expect(out.results[0].summary).toContain('42 msgs');
    expect(out.results[0].highlight).toContain('advisors movie');
    // session WAS searched → no redundant session suggestion
    expect(out.suggest_sessions).toBeUndefined();
  });

  it('highlights only content fields, never the user-scoping fields (no UUID snippets)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'q' });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const hlFields = call.highlight.fields;
    expect(hlFields['*']).toBeUndefined(); // wildcard would re-highlight user_id.keyword
    expect(hlFields.transcript_text).toBeDefined();
    expect(hlFields.content).toBeDefined();
    expect(hlFields.user_id).toBeUndefined();
    expect(hlFields['user_id.keyword']).toBeUndefined();
  });

  it('surfaces the highlight snippet that explains the match', async () => {
    const es = esReturning([
      {
        _index: 'll5_knowledge_facts',
        _id: 'f1',
        _score: 9,
        _source: { content: 'long fact text about the topic' },
        highlight: { content: ['long fact <em>text</em>'] },
      },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'text' });
    const out = parseToolResponse<Resp>(res);
    expect(out.results[0].highlight).toBe('long fact <em>text</em>');
  });

  it('timeline mode: most-recent-first, ignores per-source cap', async () => {
    // Older, term-dense "origin" entry would out-rank a recent terse "update" by score —
    // timeline mode must put the recent one first regardless of score.
    const es = esReturning([
      { _index: 'll5_agent_journal', _id: 'origin', _score: 20, _source: { topic: 'order', content: 'bought sunglasses and prescription', created_at: '2026-06-07T09:00:00Z' } },
      { _index: 'll5_agent_journal', _id: 'pickup', _score: 3, _source: { topic: 'misc', content: 'picked up sunglasses', created_at: '2026-06-19T13:00:00Z' } },
      { _index: 'll5_agent_journal', _id: 'mid', _score: 5, _source: { topic: 'place', content: 'place match optika', created_at: '2026-06-11T07:00:00Z' } },
    ]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'sunglasses', mode: 'timeline', per_source_cap: 1 });
    const out = parseToolResponse<Resp & { mode: string }>(res);
    expect(out.mode).toBe('timeline');
    // most-recent-first: the Jun 19 pickup leads despite its low score
    expect(out.results[0].id).toBe('pickup');
    expect(out.results.map((r) => r.id)).toEqual(['pickup', 'mid', 'origin']);
    // per_source_cap is ignored in timeline mode — all 3 journal hits returned, not 1
    expect(out.by_source.journal).toBe(3);
    // nothing flagged as capped in timeline mode
    expect((out as { more_available?: unknown }).more_available).toBeUndefined();
  });

  it('relevant mode: flags the cap signal when ranking hid more than it showed', async () => {
    const many: Hit[] = Array.from({ length: 8 }, (_, i) => ({
      _index: 'll5_agent_journal',
      _id: `j${i}`,
      _score: 10 - i,
      _source: { topic: 't', content: `entry ${i}`, created_at: '2026-06-10T00:00:00Z' },
    }));
    // agg says 36 journal docs actually matched, but only 8 shown (per_source_cap default)
    const es = esReturning(many, [{ key: 'll5_agent_journal', doc_count: 36 }]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'glasses' });
    const out = parseToolResponse<Resp & { more_available?: Record<string, { shown: number; matched: number }>; timeline_hint?: string }>(res);
    expect(out.more_available?.journal).toEqual({ shown: 8, matched: 36 });
    expect(out.timeline_hint).toContain('mode:"timeline"');
  });

  it('returns a structured error if ES throws', async () => {
    const es = makeMockEsClient({ search: vi.fn().mockRejectedValue(new Error('es down')) });
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'q' });
    const out = parseToolResponse<{ error: string; detail: string }>(res);
    expect(out.error).toContain('failed');
    expect(out.detail).toContain('es down');
  });
});
