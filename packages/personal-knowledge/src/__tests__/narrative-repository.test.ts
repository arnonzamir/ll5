import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchNarrativeRepository } from '../repositories/elasticsearch/narrative.repository.js';
import { narrativeDocId, narrativeRelevance, type Narrative, type SubjectRef } from '../types/narrative.js';

const USER_ID = 'user-test-1';

function makeNarrative(over: Partial<Narrative> = {}): Narrative {
  return {
    id: 'n-1',
    userId: USER_ID,
    subject: { kind: 'topic', ref: 't-1' },
    title: 'T',
    summary: '',
    openThreads: [],
    recentDecisions: [],
    participants: [],
    places: [],
    observationCount: 0,
    sensitive: false,
    status: 'active',
    ...over,
  };
}

function makeEsClient(overrides: Partial<{
  getResult: unknown;
  searchResult: unknown;
  indexResult: unknown;
  deleteByQueryResult: { deleted: number };
}> = {}): Client {
  return {
    get: vi.fn().mockResolvedValue(overrides.getResult ?? { _source: null }),
    search: vi.fn().mockResolvedValue(
      overrides.searchResult ?? { hits: { total: { value: 0 }, hits: [] } },
    ),
    index: vi.fn().mockResolvedValue(overrides.indexResult ?? { result: 'created' }),
    deleteByQuery: vi.fn().mockResolvedValue(overrides.deleteByQueryResult ?? { deleted: 0 }),
  } as unknown as Client;
}

describe('narrativeDocId', () => {
  it('produces deterministic id for the same subject', () => {
    const subject: SubjectRef = { kind: 'person', ref: 'p-tamar' };
    const a = narrativeDocId(USER_ID, subject);
    const b = narrativeDocId(USER_ID, subject);
    expect(a).toBe(b);
  });

  it('separates user / kind / ref with ::', () => {
    const id = narrativeDocId(USER_ID, { kind: 'topic', ref: 'workload-management' });
    expect(id).toBe(`${USER_ID}::topic::workload-management`);
  });

  it('handles long group JIDs', () => {
    const jid = '120363041234567890@g.us';
    const id = narrativeDocId(USER_ID, { kind: 'group', ref: jid });
    expect(id).toBe(`${USER_ID}::group::${jid}`);
  });

  it('different subjects yield different ids', () => {
    const a = narrativeDocId(USER_ID, { kind: 'person', ref: 'p-1' });
    const b = narrativeDocId(USER_ID, { kind: 'person', ref: 'p-2' });
    const c = narrativeDocId(USER_ID, { kind: 'place', ref: 'p-1' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('narrativeRelevance', () => {
  const now = Date.parse('2026-06-23T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

  it('returns a score in [0,1]', () => {
    const s = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(1) }), now);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('ranks a more-recently-active narrative higher (all else equal)', () => {
    const fresh = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(1) }), now);
    const stale = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(240) }), now);
    expect(fresh).toBeGreaterThan(stale);
  });

  it('ranks active above closed at equal recency', () => {
    const active = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(2), status: 'active' }), now);
    const closed = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(2), status: 'closed' }), now);
    expect(active).toBeGreaterThan(closed);
  });

  it('boosts open threads and observation volume', () => {
    const base = makeNarrative({ lastObservedAt: hoursAgo(2) });
    const loaded = makeNarrative({ lastObservedAt: hoursAgo(2), openThreads: ['a', 'b', 'c'], observationCount: 40 });
    expect(narrativeRelevance(loaded, now)).toBeGreaterThan(narrativeRelevance(base, now));
  });

  it('boosts a more central (more connected) narrative at equal recency', () => {
    const lonely = makeNarrative({ lastObservedAt: hoursAgo(2), participants: [] });
    const central = makeNarrative({ lastObservedAt: hoursAgo(2), participants: ['a', 'b', 'c', 'd'], places: ['p1'] });
    expect(narrativeRelevance(central, now)).toBeGreaterThan(narrativeRelevance(lonely, now));
  });

  it('treats unknown activity as very old (low score)', () => {
    const unknown = narrativeRelevance(makeNarrative({ lastObservedAt: undefined, firstObservedAt: undefined }), now);
    const recent = narrativeRelevance(makeNarrative({ lastObservedAt: hoursAgo(1) }), now);
    expect(unknown).toBeLessThan(recent);
  });
});

describe('ElasticsearchNarrativeRepository', () => {
  let esClient: Client;
  let repo: ElasticsearchNarrativeRepository;

  beforeEach(() => {
    esClient = makeEsClient();
    repo = new ElasticsearchNarrativeRepository(esClient);
  });

  describe('upsert', () => {
    it('requires title on create', async () => {
      await expect(
        repo.upsert(USER_ID, { subject: { kind: 'topic', ref: 'foo' } }),
      ).rejects.toThrow(/title is required/i);
    });

    it('requires closed_reason on transition to closed', async () => {
      // Existing narrative with no closed_reason
      const subject: SubjectRef = { kind: 'topic', ref: 'foo' };
      const id = narrativeDocId(USER_ID, subject);
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: USER_ID,
            subject: { kind: 'topic', ref: 'foo' },
            title: 'Foo',
            summary: 'existing',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 0,
            sensitive: false,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      await expect(
        r.upsert(USER_ID, { subject, status: 'closed' }),
      ).rejects.toThrow(/closed_reason is required/i);
    });

    it('uses deterministic id derived from subject', async () => {
      await repo.upsert(USER_ID, {
        subject: { kind: 'person', ref: 'p-tamar' },
        title: "Tamar's pregnancy and baby",
        summary: 'First child',
      });

      const indexCall = vi.mocked(esClient.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.id).toBe(`${USER_ID}::person::p-tamar`);
    });

    it('marks created=true when no existing doc', async () => {
      const result = await repo.upsert(USER_ID, {
        subject: { kind: 'topic', ref: 'workload' },
        title: 'Workload squeeze',
      });
      expect(result.created).toBe(true);
    });

    it('marks created=false when doc exists', async () => {
      const subject: SubjectRef = { kind: 'topic', ref: 'workload' };
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: USER_ID,
            subject: { kind: 'topic', ref: 'workload' },
            title: 'Workload squeeze',
            summary: 'existing',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 5,
            sensitive: false,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      const result = await r.upsert(USER_ID, {
        subject,
        summary: 'updated summary',
      });
      expect(result.created).toBe(false);
      expect(result.narrative.title).toBe('Workload squeeze'); // preserved
      expect(result.narrative.summary).toBe('updated summary'); // overwritten
    });

    it('bumps sensitive flag (logical OR), never lowers', async () => {
      const subject: SubjectRef = { kind: 'topic', ref: 'self-esteem' };
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: USER_ID,
            subject: { kind: 'topic', ref: 'self-esteem' },
            title: 'Self-esteem',
            summary: 'existing',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 1,
            sensitive: true,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      // Try to lower sensitive — should stay true
      const result = await r.upsert(USER_ID, { subject, sensitive: false });
      expect(result.narrative.sensitive).toBe(true);
    });

    it('promotes sensitive from false to true on bump', async () => {
      const subject: SubjectRef = { kind: 'topic', ref: 'kids' };
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: USER_ID,
            subject: { kind: 'topic', ref: 'kids' },
            title: 'Kids',
            summary: 'existing',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 0,
            sensitive: false,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      const result = await r.upsert(USER_ID, { subject, sensitive: true });
      expect(result.narrative.sensitive).toBe(true);
    });

    it('preserves first_observed_at and observation_count when not provided', async () => {
      const subject: SubjectRef = { kind: 'person', ref: 'p-tamar' };
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: USER_ID,
            subject: { kind: 'person', ref: 'p-tamar' },
            title: 'Tamar',
            summary: 'existing',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 7,
            first_observed_at: '2025-12-01T00:00:00Z',
            last_observed_at: '2026-04-01T00:00:00Z',
            sensitive: false,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      const result = await r.upsert(USER_ID, { subject, currentMood: 'happy' });
      expect(result.narrative.observationCount).toBe(7);
      expect(result.narrative.firstObservedAt).toBe('2025-12-01T00:00:00Z');
      expect(result.narrative.currentMood).toBe('happy');
    });
  });

  describe('list', () => {
    it('defaults to active status filter', async () => {
      await repo.list(USER_ID, { status: 'active' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { status: 'active' } });
    });

    it('applies subject_kind filter', async () => {
      await repo.list(USER_ID, { subjectKind: 'person' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { 'subject.kind': 'person' } });
    });

    it('applies participant filter on keyword field', async () => {
      await repo.list(USER_ID, { participantId: 'p-tamar' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { participants: 'p-tamar' } });
    });

    it('applies stale_for_days as last_observed_at lte cutoff', async () => {
      await repo.list(USER_ID, { staleForDays: 14 });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      const rangeFilter = filters.find((f) => 'range' in f) as { range: { last_observed_at: { lte: string } } } | undefined;
      expect(rangeFilter).toBeDefined();
      expect(rangeFilter!.range.last_observed_at.lte).toBeDefined();
      // Cutoff should be roughly 14 days ago — sanity check it's a valid ISO date
      const cutoff = new Date(rangeFilter!.range.last_observed_at.lte);
      const expected = Date.now() - 14 * 86_400_000;
      expect(Math.abs(cutoff.getTime() - expected)).toBeLessThan(60_000);
    });

    it('builds free-text must with title^2 boost', async () => {
      await repo.list(USER_ID, { query: 'baby' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const must = bool.must as Array<Record<string, unknown>>;
      expect(must[0]).toEqual({
        multi_match: {
          query: 'baby',
          fields: ['title^2', 'summary', 'open_threads'],
          fuzziness: 'AUTO',
        },
      });
    });

    it('sorts by last_observed_at desc with missing _last', async () => {
      await repo.list(USER_ID, {});

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.sort).toEqual([{ last_observed_at: { order: 'desc', missing: '_last' } }]);
    });
  });

  describe('getBySubject', () => {
    it('returns null on 404', async () => {
      const client = makeEsClient();
      vi.mocked(client.get).mockRejectedValue({ meta: { statusCode: 404 } });
      const r = new ElasticsearchNarrativeRepository(client);

      const result = await r.getBySubject(USER_ID, { kind: 'person', ref: 'unknown' });
      expect(result).toBeNull();
    });

    it('returns null when user_id mismatch', async () => {
      const client = makeEsClient({
        getResult: {
          _source: {
            user_id: 'other-user',
            subject: { kind: 'person', ref: 'p-1' },
            title: 'Other',
            summary: '',
            open_threads: [],
            recent_decisions: [],
            participants: [],
            places: [],
            observation_count: 0,
            sensitive: false,
            status: 'active',
          },
        },
      });
      const r = new ElasticsearchNarrativeRepository(client);

      const result = await r.getBySubject(USER_ID, { kind: 'person', ref: 'p-1' });
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('uses scoped deleteByQuery with deterministic id', async () => {
      const client = makeEsClient({ deleteByQueryResult: { deleted: 1 } });
      const r = new ElasticsearchNarrativeRepository(client);

      const ok = await r.delete(USER_ID, { kind: 'topic', ref: 'workload' });
      expect(ok).toBe(true);

      const call = vi.mocked(client.deleteByQuery).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { _id: `${USER_ID}::topic::workload` } });
      expect(filters).toContainEqual({ term: { user_id: USER_ID } });
    });
  });

  // These prove the count is recomputed LIVE from the observations index and not
  // read from the stored observation_count field. They FAIL if the live-recompute
  // is removed (the assertions demand a value different from the stored one).
  describe('observationCount is computed live, not the stored counter', () => {
    const subject: SubjectRef = { kind: 'person', ref: 'p-rotem' };
    const SUBJECT_KEY = 'person::p-rotem'; // matches subjectKey(): `${kind}::${ref}`
    const DOC_ID = `${USER_ID}::person::p-rotem`;

    function narrativeDoc(storedCount: number) {
      return {
        user_id: USER_ID,
        subject: { kind: 'person', ref: 'p-rotem' },
        title: 'Rotem',
        summary: 's',
        open_threads: [],
        recent_decisions: [],
        participants: [],
        places: [],
        observation_count: storedCount,
        sensitive: false,
        status: 'active',
      };
    }

    /** ES mock that answers the narrative index and the observations agg differently. */
    function makeClient(opts: {
      storedCount: number;
      liveCount?: number;
      observationsThrows?: boolean;
      forGet?: boolean;
    }): Client {
      return {
        get: vi.fn().mockResolvedValue({ _source: narrativeDoc(opts.storedCount) }),
        search: vi.fn().mockImplementation((params: { index?: string }) => {
          if (params.index === 'll5_knowledge_observations') {
            if (opts.observationsThrows) return Promise.reject(new Error('es unavailable'));
            return Promise.resolve({
              aggregations: {
                per_subject: { buckets: { [SUBJECT_KEY]: { doc_count: opts.liveCount ?? 0 } } },
              },
            });
          }
          // narrative index search (used by list)
          return Promise.resolve({
            hits: {
              total: { value: opts.forGet ? 0 : 1 },
              hits: opts.forGet ? [] : [{ _id: DOC_ID, _source: narrativeDoc(opts.storedCount) }],
            },
          });
        }),
        index: vi.fn().mockResolvedValue({ result: 'updated' }),
        deleteByQuery: vi.fn().mockResolvedValue({ deleted: 0 }),
      } as unknown as Client;
    }

    it('list(): uses the live count, overriding a stale stored 0', async () => {
      const r = new ElasticsearchNarrativeRepository(makeClient({ storedCount: 0, liveCount: 73 }));
      const { items } = await r.list(USER_ID, { status: 'active' });
      expect(items[0].observationCount).toBe(73);
    });

    it('list(): live count overrides even a non-zero stored count', async () => {
      const r = new ElasticsearchNarrativeRepository(makeClient({ storedCount: 5, liveCount: 73 }));
      const { items } = await r.list(USER_ID, {});
      expect(items[0].observationCount).toBe(73); // not the stored 5
    });

    it('getBySubject(): returns the live count, not the stored 0', async () => {
      const r = new ElasticsearchNarrativeRepository(makeClient({ storedCount: 0, liveCount: 42, forGet: true }));
      const n = await r.getBySubject(USER_ID, subject);
      expect(n?.observationCount).toBe(42);
    });

    it('queries the observations index with a per-subject filters aggregation', async () => {
      const client = makeClient({ storedCount: 0, liveCount: 1 });
      const r = new ElasticsearchNarrativeRepository(client);
      await r.list(USER_ID, {});
      const obsCall = vi
        .mocked(client.search)
        .mock.calls.find((c) => (c[0] as { index?: string }).index === 'll5_knowledge_observations');
      expect(obsCall).toBeDefined();
      const body = obsCall![0] as { aggs: { per_subject: { filters: { filters: Record<string, unknown> } } } };
      expect(body.aggs.per_subject.filters.filters[SUBJECT_KEY]).toBeDefined();
    });

    it('falls back to the stored count when the observations query fails', async () => {
      const r = new ElasticsearchNarrativeRepository(makeClient({ storedCount: 9, observationsThrows: true }));
      const { items } = await r.list(USER_ID, {});
      expect(items[0].observationCount).toBe(9); // stored fallback — reads never break
    });
  });

  describe('selectConsolidationWork', () => {
    const now = Date.now();
    const minsAgo = (m: number) => new Date(now - m * 60_000).toISOString();

    /** ES mock dispatching narrative-index vs observations-index searches. */
    function makeWorkClient(opts: {
      narratives: Array<{ kind: string; ref: string; status?: string; title?: string; last_consolidated_at?: string }>;
      observations: Array<{ subjects: Array<{ kind: string; ref: string }>; observed_at: string; text?: string }>;
    }): Client {
      return {
        get: vi.fn().mockResolvedValue({ _source: null }),
        search: vi.fn().mockImplementation((params: { index?: string }) => {
          if (params.index === 'll5_knowledge_observations') {
            return Promise.resolve({ hits: { hits: opts.observations.map((o) => ({ _source: o })) } });
          }
          return Promise.resolve({
            hits: {
              hits: opts.narratives.map((n) => ({
                _source: {
                  user_id: USER_ID,
                  subject: { kind: n.kind, ref: n.ref },
                  status: n.status ?? 'active',
                  title: n.title ?? `${n.kind}:${n.ref}`,
                  last_consolidated_at: n.last_consolidated_at,
                },
              })),
            },
          });
        }),
        index: vi.fn(),
        deleteByQuery: vi.fn(),
      } as unknown as Client;
    }

    it('promotes a subject with no narrative to CREATE at threshold 1', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [],
        observations: [{ subjects: [{ kind: 'person', ref: 'p-new' }], observed_at: minsAgo(5), text: 'met someone new' }],
      }));
      const work = await r.selectConsolidationWork(USER_ID);
      expect(work.orphans.map((o) => o.subject.ref)).toContain('p-new');
      expect(work.orphans[0].sample).toBe('met someone new');
      expect(work.stale).toHaveLength(0);
    });

    it('marks an active narrative STALE when it has new activity past the debounce', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [{ kind: 'topic', ref: 't-1', last_consolidated_at: minsAgo(180) }],
        observations: [{ subjects: [{ kind: 'topic', ref: 't-1' }], observed_at: minsAgo(10) }],
      }));
      const work = await r.selectConsolidationWork(USER_ID);
      expect(work.stale.map((s) => s.subject.ref)).toContain('t-1');
      expect(work.orphans).toHaveLength(0);
    });

    it('debounces a narrative consolidated within debounce_minutes', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [{ kind: 'topic', ref: 't-1', last_consolidated_at: minsAgo(5) }],
        observations: [{ subjects: [{ kind: 'topic', ref: 't-1' }], observed_at: minsAgo(2) }],
      }));
      const work = await r.selectConsolidationWork(USER_ID, { debounceMinutes: 45 });
      expect(work.stale).toHaveLength(0);
    });

    it('skips dormant/closed narratives even with new activity', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [{ kind: 'topic', ref: 't-dorm', status: 'dormant', last_consolidated_at: minsAgo(500) }],
        observations: [{ subjects: [{ kind: 'topic', ref: 't-dorm' }], observed_at: minsAgo(10) }],
      }));
      const work = await r.selectConsolidationWork(USER_ID);
      expect(work.stale).toHaveLength(0);
      expect(work.orphans).toHaveLength(0); // it HAS a narrative, just not active — not an orphan
    });

    it('does not refresh a narrative already consolidated past its latest observation', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [{ kind: 'topic', ref: 't-fresh', last_consolidated_at: minsAgo(60) }],
        observations: [{ subjects: [{ kind: 'topic', ref: 't-fresh' }], observed_at: minsAgo(120) }],
      }));
      const work = await r.selectConsolidationWork(USER_ID);
      expect(work.stale).toHaveLength(0);
    });

    it('respects promote_threshold (a 1-observation subject is excluded at threshold 2)', async () => {
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({
        narratives: [],
        observations: [{ subjects: [{ kind: 'topic', ref: 't-once' }], observed_at: minsAgo(5) }],
      }));
      const work = await r.selectConsolidationWork(USER_ID, { promoteThreshold: 2 });
      expect(work.orphans).toHaveLength(0);
    });

    it('caps each side at max', async () => {
      const observations = Array.from({ length: 10 }, (_, i) => ({
        subjects: [{ kind: 'topic', ref: `orphan-${i}` }],
        observed_at: minsAgo(i + 1),
      }));
      const r = new ElasticsearchNarrativeRepository(makeWorkClient({ narratives: [], observations }));
      const work = await r.selectConsolidationWork(USER_ID, { max: 3 });
      expect(work.orphans).toHaveLength(3);
    });
  });
});
