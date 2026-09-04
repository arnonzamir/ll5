import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// Partial mock: keep the real cap/cursor helpers, silence the audit ES write.
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return { ...actual, logAudit: vi.fn() };
});
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { decodeCursor, MCP_RESULT_CAP_CHARS } from '@ll5/shared';
import { registerNarrativeTools, resolveSubjects, normalizeSource } from '../tools/narratives.js';
import { registerPeopleTools } from '../tools/people.js';
import { registerFactTools } from '../tools/facts.js';
import { captureTools, parseToolResponse, type ToolHandler } from './_helpers.js';
import type { ObservationRepository } from '../repositories/interfaces/observation.repository.js';
import type { NarrativeRepository } from '../repositories/interfaces/narrative.repository.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import type { FactRepository } from '../repositories/interfaces/fact.repository.js';
import type { Observation, Narrative } from '../types/narrative.js';

const USER_ID = 'user-pk-1';
const getUserId = () => USER_ID;

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

function obs(i: number, size = 900): Observation {
  return {
    id: `o${i}`,
    userId: USER_ID,
    subjects: [{ kind: 'person', ref: 'p-tamar' }],
    text: `${i}:` + 'x'.repeat(size),
    source: 'chat',
    confidence: 'medium',
    sensitive: false,
    observedAt: new Date(Date.UTC(2026, 8, 3) - i * 3_600_000).toISOString(),
    createdAt: '2026-09-03T00:00:00Z',
  };
}
const ALL_OBS = Array.from({ length: 200 }, (_, i) => obs(i));

function narrative(i: number, size = 900): Narrative {
  return {
    id: `n${i}`,
    userId: USER_ID,
    subject: { kind: 'topic', ref: `t-${i}` },
    title: `Thread ${i}`,
    summary: `${i}:` + 'x'.repeat(size),
    openThreads: [],
    recentDecisions: [],
    participants: [],
    places: [],
    observationCount: 3,
    sensitive: false,
    status: 'active',
  };
}
const ALL_NARR = Array.from({ length: 100 }, (_, i) => narrative(i));

interface Repos {
  observationRepo: ObservationRepository & { create: ReturnType<typeof vi.fn>; recall: ReturnType<typeof vi.fn> };
  narrativeRepo: NarrativeRepository & { list: ReturnType<typeof vi.fn> };
  personRepo: PersonRepository & { get: ReturnType<typeof vi.fn> };
  placeRepo: PlaceRepository;
}

function makeRepos(over: { narrative?: Narrative | null } = {}): Repos {
  return {
    observationRepo: {
      create: vi.fn(async (_u: string, input: Record<string, unknown>) => ({ ...obs(0, 5), ...input, id: 'new-obs' })),
      recall: vi.fn(async (_u: string, f: { limit?: number; offset?: number }) => ALL_OBS.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 30))),
    } as unknown as Repos['observationRepo'],
    narrativeRepo: {
      getBySubject: vi.fn(async () => over.narrative ?? null),
      list: vi.fn(async (_u: string, f: { limit?: number; offset?: number }) => ({
        items: ALL_NARR.slice(f.offset ?? 0, (f.offset ?? 0) + (f.limit ?? 50)),
        total: ALL_NARR.length,
      })),
    } as unknown as Repos['narrativeRepo'],
    personRepo: { get: vi.fn(async (_u: string, id: string) => ({ id, name: id })) } as unknown as Repos['personRepo'],
    placeRepo: { get: vi.fn(async () => null) } as unknown as PlaceRepository,
  };
}

function register(r: Repos) {
  return (s: McpServer) => registerNarrativeTools(s, r.observationRepo, r.narrativeRepo, r.personRepo, r.placeRepo, getUserId);
}

// ---------------------------------------------------------------------------
// note_observation — ISS-021 (first: the whole knowledge chain depends on it)
// ---------------------------------------------------------------------------
describe('note_observation — ISS-021 aliases + source normalization', () => {
  it('live payload 1: `subject` as a JSON string + `content` → stored, shape normalization echoed', async () => {
    const r = makeRepos();
    const tools = captureWithSchemas(register(r));
    const t = tools.get('note_observation')!;
    const live = {
      subject: '{"kind": "person", "ref": "arnon"}',
      content: 'Night activity 01:00 Mon — phone unlock post-swim.',
      source: 'inference',
      confidence: 'low',
    };
    expect(validate(t, live).success).toBe(true);

    const out = parseToolResponse<{ observation: { id: string }; normalized: Record<string, string> }>(await t.handler(live));
    expect(out.observation.id).toBe('new-obs');
    expect(out.normalized).toEqual({ text: 'content', subjects: 'subject' });
    // person ref validated against the repo under USER_ID
    expect(r.personRepo.get).toHaveBeenCalledWith(USER_ID, 'arnon');
    expect(r.observationRepo.create.mock.calls[0][0]).toBe(USER_ID);
    expect(r.observationRepo.create.mock.calls[0][1]).toMatchObject({
      subjects: [{ kind: 'person', ref: 'arnon' }],
      text: live.content,
      source: 'inference',
      confidence: 'low',
    });
  });

  it('live payload 2: `content` + source:"observation" → text taken, source normalized to inference and reported', async () => {
    const r = makeRepos();
    const tools = captureWithSchemas(register(r));
    const t = tools.get('note_observation')!;
    const live = {
      subjects: [{ kind: 'person', ref: 'itamar-zamir' }, { kind: 'topic', ref: 'itamar-krav-maga' }],
      content: 'Photo Arnon took at Itamar\'s KM class.',
      source: 'observation',
    };
    expect(validate(t, live).success).toBe(true);
    const out = parseToolResponse<{ normalized: Record<string, string> }>(await t.handler(live));
    expect(out.normalized).toEqual({ source: 'observation → inference', text: 'content' });
    expect(r.observationRepo.create.mock.calls[0][1]).toMatchObject({ source: 'inference', text: live.content });
  });

  it('canonical payload is stored verbatim with no `normalized` field', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    const out = parseToolResponse<Record<string, unknown>>(
      await tools.get('note_observation')!({ subjects: [{ kind: 'topic', ref: 'x' }], text: 'hello', source: 'user_statement', confidence: 'high' }),
    );
    expect(out.normalized).toBeUndefined();
    expect(r.observationRepo.create.mock.calls[0][1]).toMatchObject({ source: 'user_statement', text: 'hello' });
  });

  it('missing text/content or missing subjects → structured error, nothing stored', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    const noText = await tools.get('note_observation')!({ subjects: [{ kind: 'topic', ref: 'x' }], source: 'chat' });
    expect(noText.isError).toBe(true);
    const noSubj = await tools.get('note_observation')!({ text: 'hi', source: 'chat' });
    expect(noSubj.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(noSubj).error).toMatch(/subjects/);
    expect(r.observationRepo.create).not.toHaveBeenCalled();
  });

  it('resolveSubjects / normalizeSource (pure)', () => {
    expect(resolveSubjects(undefined, { kind: 'place', ref: 'home' })).toEqual({ subjects: [{ kind: 'place', ref: 'home' }] });
    expect(resolveSubjects(undefined, '[{"kind":"group","ref":"g1"}]')).toEqual({ subjects: [{ kind: 'group', ref: 'g1' }] });
    expect(resolveSubjects(undefined, '{bad json')).toMatchObject({ error: expect.stringMatching(/JSON/) });
    expect(resolveSubjects(undefined, { kind: 'planet', ref: 'x' } as never)).toMatchObject({ error: expect.stringMatching(/subjects/) });
    expect(normalizeSource('whatsapp')).toEqual({ source: 'whatsapp' });
    expect(normalizeSource('User')).toEqual({ source: 'user_statement', normalized: 'User → user_statement' });
    expect(normalizeSource('photo')).toEqual({ source: 'inference', normalized: 'photo → inference' });
    expect(normalizeSource(undefined)).toEqual({ source: 'inference', normalized: '(missing) → inference' });
    expect(normalizeSource('made-up')).toEqual({ source: 'inference', normalized: 'made-up → inference' });
  });
});

// ---------------------------------------------------------------------------
// recall — ISS-019
// ---------------------------------------------------------------------------
describe('recall — ISS-019 cap + cursor', () => {
  it('asks for limit+1, caps at observation boundaries, next_cursor continues where page 1 stopped', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    const p1 = await tools.get('recall')!({ subjects: [{ kind: 'person', ref: 'p-tamar' }], limit: 100 });
    expect(p1.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    expect(r.observationRepo.recall.mock.calls[0][0]).toBe(USER_ID);
    expect(r.observationRepo.recall.mock.calls[0][1]).toMatchObject({ limit: 101 });
    const o1 = parseToolResponse<{ narratives: unknown[]; observations: Array<{ id: string; text: string }>; truncated: boolean; next_cursor: string; hint: string }>(p1);
    expect(o1.observations.length).toBeLessThan(100);
    expect(o1.observations[0].id).toBe('o0');
    for (const o of o1.observations) expect(o.text.length).toBeGreaterThan(900);
    expect(o1.truncated).toBe(true);
    expect(o1.hint).toMatch(/since/);
    expect(decodeCursor(o1.next_cursor)).toBe(o1.observations.length);

    const p2 = parseToolResponse<{ observations: Array<{ id: string }> }>(
      await tools.get('recall')!({ subjects: [{ kind: 'person', ref: 'p-tamar' }], limit: 100, cursor: o1.next_cursor }),
    );
    expect(r.observationRepo.recall.mock.calls[1][1]).toMatchObject({ limit: 101, offset: o1.observations.length });
    expect(p2.observations[0].id).toBe(`o${o1.observations.length}`);
  });

  it('small result is byte-identical to the pre-cap envelope', async () => {
    const r = makeRepos();
    r.observationRepo.recall = vi.fn(async () => [obs(0, 5), obs(1, 5)]) as never;
    const tools = captureTools(register(r));
    const res = await tools.get('recall')!({ query: 'x' });
    expect(res.content[0].text).toBe(JSON.stringify({ narratives: [], observations: [obs(0, 5), obs(1, 5)] }));
  });
});

// ---------------------------------------------------------------------------
// list_narratives — ISS-019 (also consumed by gateway + dashboard → max_chars)
// ---------------------------------------------------------------------------
describe('list_narratives — ISS-019 cap + cursor + max_chars', () => {
  it('caps at narrative boundaries, keeps the true total, pages via cursor', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    const p1 = await tools.get('list_narratives')!({ status: 'active', limit: 30 });
    expect(p1.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const o1 = parseToolResponse<{ narratives: Array<{ id: string; summary: string }>; total: number; truncated: boolean; next_cursor: string; hint: string }>(p1);
    expect(o1.narratives.length).toBeLessThan(30);
    expect(o1.narratives[0].id).toBe('n0');
    for (const n of o1.narratives) expect(n.summary.length).toBeGreaterThan(900);
    expect(o1.total).toBe(100);
    expect(o1.truncated).toBe(true);
    expect(o1.hint).toMatch(/subject_kind/);
    expect(r.narrativeRepo.list.mock.calls[0][0]).toBe(USER_ID);
    expect(r.narrativeRepo.list.mock.calls[0][1]).toMatchObject({ status: 'active', limit: 30, offset: 0 });

    const p2 = parseToolResponse<{ narratives: Array<{ id: string }> }>(
      await tools.get('list_narratives')!({ status: 'active', limit: 30, cursor: o1.next_cursor }),
    );
    expect(r.narrativeRepo.list.mock.calls[1][1]).toMatchObject({ offset: o1.narratives.length });
    expect(p2.narratives[0].id).toBe(`n${o1.narratives.length}`);
  });

  it('legacy offset still works; cursor wins when both are given', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    await tools.get('list_narratives')!({ offset: 7, limit: 2 });
    expect(r.narrativeRepo.list.mock.calls[0][1]).toMatchObject({ offset: 7 });
    const p = parseToolResponse<{ next_cursor: string }>(await tools.get('list_narratives')!({ limit: 2 }));
    await tools.get('list_narratives')!({ offset: 99, limit: 2, cursor: p.next_cursor });
    expect(r.narrativeRepo.list.mock.calls[2][1]).toMatchObject({ offset: 2 });
  });

  it('max_chars (programmatic consumers) raises the cap; hasMore still reports truncated', async () => {
    const r = makeRepos();
    const tools = captureTools(register(r));
    const out = parseToolResponse<{ narratives: unknown[]; truncated: boolean; next_cursor: string }>(
      await tools.get('list_narratives')!({ limit: 30, max_chars: 100_000 }),
    );
    expect(out.narratives.length).toBe(30);
    expect(out.truncated).toBe(true); // 30 of 100
    expect(decodeCursor(out.next_cursor)).toBe(30);
  });

  it('small result is byte-identical to the pre-cap envelope', async () => {
    const r = makeRepos();
    r.narrativeRepo.list = vi.fn(async () => ({ items: [narrative(0, 5)], total: 1 })) as never;
    const tools = captureTools(register(r));
    const res = await tools.get('list_narratives')!({});
    expect(res.content[0].text).toBe(JSON.stringify({ narratives: [narrative(0, 5)], total: 1 }));
  });
});

// ---------------------------------------------------------------------------
// get_narrative — ISS-019
// ---------------------------------------------------------------------------
describe('get_narrative — ISS-019 cap + cursor', () => {
  it('narrative always whole; observations capped with cursor', async () => {
    const r = makeRepos({ narrative: narrative(0, 3000) });
    const tools = captureTools(register(r));
    const p1 = await tools.get('get_narrative')!({ subject: { kind: 'topic', ref: 't-0' }, observation_limit: 100 });
    expect(p1.content[0].text.length).toBeLessThanOrEqual(MCP_RESULT_CAP_CHARS);
    const o1 = parseToolResponse<{ narrative: { id: string; summary: string }; observations: Array<{ id: string }>; truncated: boolean; next_cursor: string }>(p1);
    expect(o1.narrative.id).toBe('n0');
    expect(o1.narrative.summary.length).toBeGreaterThan(3000);
    expect(o1.observations.length).toBeLessThan(100);
    expect(o1.truncated).toBe(true);
    expect(r.observationRepo.recall.mock.calls[0][1]).toMatchObject({ limit: 101 });

    const p2 = parseToolResponse<{ observations: Array<{ id: string }> }>(
      await tools.get('get_narrative')!({ subject: { kind: 'topic', ref: 't-0' }, observation_limit: 100, cursor: o1.next_cursor }),
    );
    expect(p2.observations[0].id).toBe(`o${o1.observations.length}`);
  });

  it('empty subject keeps the pre-cap "nothing yet" envelope', async () => {
    const r = makeRepos();
    r.observationRepo.recall = vi.fn(async () => []) as never;
    const tools = captureTools(register(r));
    const res = await tools.get('get_narrative')!({ subject: { kind: 'topic', ref: 'none' } });
    expect(res.content[0].text).toBe(JSON.stringify({ narrative: null, observations: [], note: 'No narrative or observations exist for this subject yet.' }));
  });
});

// ---------------------------------------------------------------------------
// get_person — ISS-021 person_id alias
// ---------------------------------------------------------------------------
describe('get_person — ISS-021 person_id alias', () => {
  function personRepo(get = vi.fn(async (_u: string, id: string) => ({ id, name: 'X', aliases: [], tags: [], status: 'full', userId: USER_ID, createdAt: '', updatedAt: '' }))) {
    return { repo: { get } as unknown as PersonRepository, get };
  }

  it('accepts the live `person_id` payload and looks the person up under USER_ID', async () => {
    const { repo, get } = personRepo();
    const tools = captureWithSchemas((s) => registerPeopleTools(s, repo, getUserId));
    const t = tools.get('get_person')!;
    const live = { person_id: 'f17b0966-2b5b-4213-9f92-e5f615bab32b' };
    expect(validate(t, live).success).toBe(true);
    const out = parseToolResponse<{ id: string } | { person: { id: string } }>(await t.handler(live));
    expect(JSON.stringify(out)).toContain('f17b0966-2b5b-4213-9f92-e5f615bab32b');
    expect(get).toHaveBeenCalledWith(USER_ID, 'f17b0966-2b5b-4213-9f92-e5f615bab32b');
  });

  it('`id` still works; neither → structured error', async () => {
    const { repo, get } = personRepo();
    const tools = captureTools((s) => registerPeopleTools(s, repo, getUserId));
    await tools.get('get_person')!({ id: 'p1' });
    expect(get).toHaveBeenCalledWith(USER_ID, 'p1');
    const res = await tools.get('get_person')!({});
    expect(res.isError).toBe(true);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// upsert_fact — ISS-021 defaults + key/value aliases
// ---------------------------------------------------------------------------
describe('upsert_fact — ISS-021 defaults', () => {
  function factRepo() {
    const upsert = vi.fn(async (_u: string, data: Record<string, unknown>) => ({ fact: { id: 'f-new', ...data }, created: true }));
    return { repo: { upsert } as unknown as FactRepository, upsert };
  }

  it('live payload {content, tags}: stored with defaults type=other, category=general, provenance=observed, confidence=0.7 (echoed)', async () => {
    const { repo, upsert } = factRepo();
    const tools = captureWithSchemas((s) => registerFactTools(s, repo, getUserId));
    const t = tools.get('upsert_fact')!;
    const live = { content: 'Uriya signed up for soccer.', tags: ['kids', 'soccer'] };
    expect(validate(t, live).success).toBe(true);
    const out = parseToolResponse<{ created: boolean; defaults_applied: Record<string, unknown> }>(await t.handler(live));
    expect(out.created).toBe(true);
    expect(out.defaults_applied).toEqual({ type: 'other', category: 'general', provenance: 'observed', confidence: 0.7 });
    expect(upsert.mock.calls[0][0]).toBe(USER_ID);
    expect(upsert.mock.calls[0][1]).toMatchObject({ type: 'other', category: 'general', content: live.content, provenance: 'observed', confidence: 0.7, tags: live.tags });
  });

  it('live payload {key, value}: value → content, key → category', async () => {
    const { repo, upsert } = factRepo();
    const tools = captureWithSchemas((s) => registerFactTools(s, repo, getUserId));
    const t = tools.get('upsert_fact')!;
    const live = { key: 'uriya-soccer-signup', value: 'Uriya signed up for soccer on Tue Sep 1 2026.' };
    expect(validate(t, live).success).toBe(true);
    await t.handler(live);
    expect(upsert.mock.calls[0][1]).toMatchObject({ content: live.value, category: 'uriya-soccer-signup' });
  });

  it('fully specified fact: no defaults echoed; no content at all → error', async () => {
    const { repo, upsert } = factRepo();
    const tools = captureTools((s) => registerFactTools(s, repo, getUserId));
    const out = parseToolResponse<Record<string, unknown>>(
      await tools.get('upsert_fact')!({ type: 'preference', category: 'food', content: 'likes hummus', provenance: 'user-stated', confidence: 0.9 }),
    );
    expect(out.defaults_applied).toBeUndefined();
    const res = await tools.get('upsert_fact')!({ tags: ['x'] });
    expect(res.isError).toBe(true);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
