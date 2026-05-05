import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchObservationRepository } from '../repositories/elasticsearch/observation.repository.js';
import type { SubjectRef } from '../types/narrative.js';

function makeEsClient(overrides: Partial<{
  searchResult: unknown;
  indexResult: unknown;
  deleteByQueryResult: { deleted: number };
}> = {}): Client {
  return {
    search: vi.fn().mockResolvedValue(
      overrides.searchResult ?? { hits: { total: { value: 0 }, hits: [] }, aggregations: {} },
    ),
    index: vi.fn().mockResolvedValue(overrides.indexResult ?? { result: 'created' }),
    deleteByQuery: vi.fn().mockResolvedValue(overrides.deleteByQueryResult ?? { deleted: 0 }),
    get: vi.fn().mockResolvedValue({ _source: null }),
  } as unknown as Client;
}

const USER_ID = 'user-test-1';

describe('ElasticsearchObservationRepository', () => {
  let esClient: Client;
  let repo: ElasticsearchObservationRepository;

  beforeEach(() => {
    esClient = makeEsClient();
    repo = new ElasticsearchObservationRepository(esClient);
  });

  describe('create', () => {
    it('writes a doc with snake_case fields and the right defaults', async () => {
      const obs = await repo.create(USER_ID, {
        subjects: [{ kind: 'person', ref: 'p-tamar' }],
        text: 'Tamar mentioned the baby is sleeping through the night',
        source: 'whatsapp',
        sourceId: 'msg-123',
      });

      expect(obs.userId).toBe(USER_ID);
      expect(obs.subjects).toEqual([{ kind: 'person', ref: 'p-tamar' }]);
      expect(obs.confidence).toBe('medium'); // default
      expect(obs.sensitive).toBe(false); // default
      expect(obs.observedAt).toBeDefined();
      expect(obs.createdAt).toBeDefined();

      const indexCall = vi.mocked(esClient.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.index).toBe('ll5_knowledge_observations');
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.user_id).toBe(USER_ID);
      expect(doc.source).toBe('whatsapp');
      expect(doc.source_id).toBe('msg-123');
      expect(doc.subjects).toEqual([{ kind: 'person', ref: 'p-tamar' }]);
    });

    it('preserves explicit confidence and sensitive flag', async () => {
      const obs = await repo.create(USER_ID, {
        subjects: [{ kind: 'topic', ref: 'self-esteem' }],
        text: 'User said "I feel like I\'m falling behind everyone"',
        source: 'user_statement',
        confidence: 'high',
        sensitive: true,
        mood: 'down',
      });

      expect(obs.confidence).toBe('high');
      expect(obs.sensitive).toBe(true);
      expect(obs.mood).toBe('down');
    });

    it('supports multi-subject observations', async () => {
      const obs = await repo.create(USER_ID, {
        subjects: [
          { kind: 'group', ref: '120363@g.us' },
          { kind: 'person', ref: 'p-itamar' },
        ],
        text: 'Discussion about the school trip in family group',
        source: 'whatsapp',
      });

      expect(obs.subjects).toHaveLength(2);
      expect(obs.subjects[0].kind).toBe('group');
      expect(obs.subjects[1].kind).toBe('person');
    });
  });

  describe('recall', () => {
    it('builds nested subject filter', async () => {
      await repo.recall(USER_ID, {
        subjects: [{ kind: 'person', ref: 'p-tamar' }],
        limit: 50,
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;

      // user_id + nested subjects
      expect(filters).toHaveLength(2);
      expect(filters[0]).toEqual({ term: { user_id: USER_ID } });

      const nested = filters[1] as { nested: { path: string; query: { bool: { should: unknown[] } } } };
      expect(nested.nested.path).toBe('subjects');
      expect(nested.nested.query.bool.should).toHaveLength(1);
    });

    it('combines multiple subjects with OR semantics', async () => {
      await repo.recall(USER_ID, {
        subjects: [
          { kind: 'person', ref: 'p-tamar' },
          { kind: 'topic', ref: 'baby' },
        ],
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      const nested = filters[1] as { nested: { query: { bool: { should: unknown[]; minimum_should_match: number } } } };
      expect(nested.nested.query.bool.should).toHaveLength(2);
      expect(nested.nested.query.bool.minimum_should_match).toBe(1);
    });

    it('adds free-text must clause when query provided', async () => {
      await repo.recall(USER_ID, {
        subjects: [{ kind: 'person', ref: 'p-1' }],
        query: 'baby',
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const must = bool.must as Array<Record<string, unknown>>;
      expect(must).toBeDefined();
      expect(must[0]).toEqual({
        multi_match: {
          query: 'baby',
          fields: ['text', 'source_excerpt'],
          fuzziness: 'AUTO',
        },
      });
    });

    it('adds since range filter', async () => {
      await repo.recall(USER_ID, {
        subjects: [{ kind: 'person', ref: 'p-1' }],
        since: '2026-04-01T00:00:00Z',
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ range: { observed_at: { gte: '2026-04-01T00:00:00Z' } } });
    });

    it('sorts by observed_at descending', async () => {
      await repo.recall(USER_ID, { subjects: [{ kind: 'person', ref: 'p-1' }] });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.sort).toEqual([{ observed_at: { order: 'desc' } }]);
    });

    it('uses default limit 30', async () => {
      await repo.recall(USER_ID, { subjects: [{ kind: 'person', ref: 'p-1' }] });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.size).toBe(30);
    });
  });

  describe('statsForSubject', () => {
    it('returns count + min/max + sensitive flag from aggs', async () => {
      const subject: SubjectRef = { kind: 'person', ref: 'p-tamar' };
      const client = makeEsClient({
        searchResult: {
          hits: { total: { value: 12 }, hits: [] },
          aggregations: {
            first_seen: { value: 1700000000000, value_as_string: '2023-11-14T22:13:20Z' },
            last_seen: { value: 1707000000000, value_as_string: '2024-02-04T01:20:00Z' },
            any_sensitive: { value: 1 },
          },
        },
      });
      const r = new ElasticsearchObservationRepository(client);

      const stats = await r.statsForSubject(USER_ID, subject);
      expect(stats.count).toBe(12);
      expect(stats.firstObservedAt).toBe('2023-11-14T22:13:20Z');
      expect(stats.lastObservedAt).toBe('2024-02-04T01:20:00Z');
      expect(stats.sensitive).toBe(true);
    });

    it('returns sensitive=false when aggregation max is 0', async () => {
      const client = makeEsClient({
        searchResult: {
          hits: { total: { value: 3 }, hits: [] },
          aggregations: {
            first_seen: { value: null },
            last_seen: { value: null },
            any_sensitive: { value: 0 },
          },
        },
      });
      const r = new ElasticsearchObservationRepository(client);

      const stats = await r.statsForSubject(USER_ID, { kind: 'topic', ref: 'workload' });
      expect(stats.sensitive).toBe(false);
    });
  });

  describe('listForSubject', () => {
    it('sorts ascending for chronological consolidation', async () => {
      await repo.listForSubject(USER_ID, { kind: 'person', ref: 'p-1' }, { since: '2026-04-01T00:00:00Z' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.sort).toEqual([{ observed_at: { order: 'asc' } }]);
    });

    it('uses larger default limit (200) for consolidation', async () => {
      await repo.listForSubject(USER_ID, { kind: 'person', ref: 'p-1' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.size).toBe(200);
    });
  });

  describe('delete', () => {
    it('uses scoped deleteByQuery', async () => {
      const client = makeEsClient({ deleteByQueryResult: { deleted: 1 } });
      const r = new ElasticsearchObservationRepository(client);

      const ok = await r.delete(USER_ID, 'obs-123');
      expect(ok).toBe(true);

      const call = vi.mocked(client.deleteByQuery).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { _id: 'obs-123' } });
      expect(filters).toContainEqual({ term: { user_id: USER_ID } });
    });

    it('returns false when nothing was deleted', async () => {
      const client = makeEsClient({ deleteByQueryResult: { deleted: 0 } });
      const r = new ElasticsearchObservationRepository(client);

      const ok = await r.delete(USER_ID, 'nonexistent');
      expect(ok).toBe(false);
    });
  });
});
