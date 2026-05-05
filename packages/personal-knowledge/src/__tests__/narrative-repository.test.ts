import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchNarrativeRepository } from '../repositories/elasticsearch/narrative.repository.js';
import { narrativeDocId, type SubjectRef } from '../types/narrative.js';

const USER_ID = 'user-test-1';

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
});
