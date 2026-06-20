import { describe, it, expect, vi } from 'vitest';
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

function esReturning(hits: Hit[]) {
  return makeMockEsClient({
    search: vi.fn().mockResolvedValue({ hits: { hits } }),
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

  it('does NOT sweep session history by default (opt-in only)', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    await tools.get('recall_everything')!({ query: 'q' });
    const call = (es.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.index).not.toContain('ll5_session_history');
    // but the user filter is ready to scope dynamic-mapped session docs too
    const should = call.query.bool.filter[0].bool.should;
    expect(should).toContainEqual({ term: { 'user_id.keyword': 'user-1' } });
  });

  it('thin default sweep suggests the session layer as a deeper reach', async () => {
    const es = esReturning([]);
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'q' });
    const out = parseToolResponse<Resp>(res);
    expect(out.suggest_sessions).toBe(true);
    expect(out.note).toContain('sources:["session"]');
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

  it('returns a structured error if ES throws', async () => {
    const es = makeMockEsClient({ search: vi.fn().mockRejectedValue(new Error('es down')) });
    const tools = captureTools((s) => registerRecallEverythingTool(s, es as never, getUserId));
    const res = await tools.get('recall_everything')!({ query: 'q' });
    const out = parseToolResponse<{ error: string; detail: string }>(res);
    expect(out.error).toContain('failed');
    expect(out.detail).toContain('es down');
  });
});
