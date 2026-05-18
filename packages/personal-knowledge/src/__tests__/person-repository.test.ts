import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { ElasticsearchPersonRepository } from '../repositories/elasticsearch/person.repository.js';

const USER_ID = 'user-test-1';

function makeEsClient(overrides: Partial<{
  searchResult: unknown;
  getResult: unknown;
  indexResult: unknown;
  deleteByQueryResult: { deleted: number };
}> = {}): Client {
  return {
    search: vi.fn().mockResolvedValue(
      overrides.searchResult ?? { hits: { total: { value: 0 }, hits: [] } },
    ),
    get: vi.fn().mockResolvedValue(overrides.getResult ?? { _source: null }),
    index: vi.fn().mockResolvedValue(overrides.indexResult ?? { result: 'created' }),
    deleteByQuery: vi.fn().mockResolvedValue(overrides.deleteByQueryResult ?? { deleted: 0 }),
  } as unknown as Client;
}

describe('ElasticsearchPersonRepository', () => {
  let esClient: Client;
  let repo: ElasticsearchPersonRepository;

  beforeEach(() => {
    esClient = makeEsClient();
    repo = new ElasticsearchPersonRepository(esClient);
  });

  describe('list (filters & query construction)', () => {
    it('always scopes by user_id', async () => {
      await repo.list(USER_ID, {});

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.index).toBe('ll5_knowledge_people');
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters[0]).toEqual({ term: { user_id: USER_ID } });
    });

    it('builds status filter for contact-only', async () => {
      await repo.list(USER_ID, { status: 'contact-only' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { status: 'contact-only' } });
    });

    it('builds status filter for full (must_not contact-only)', async () => {
      await repo.list(USER_ID, { status: 'full' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({
        bool: { must_not: [{ term: { status: 'contact-only' } }] },
      });
    });

    it('includes relationship filter when provided', async () => {
      await repo.list(USER_ID, { relationship: 'family' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { relationship: 'family' } });
    });

    it('includes tag filters with AND logic (one term clause per tag)', async () => {
      await repo.list(USER_ID, { tags: ['work', 'important'] });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { tags: 'work' } });
      expect(filters).toContainEqual({ term: { tags: 'important' } });
    });

    it('adds multi_match must clause for free-text query', async () => {
      await repo.list(USER_ID, { query: 'alice' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const must = bool.must as Array<Record<string, unknown>>;
      expect(must).toBeDefined();
      expect(must[0]).toEqual({
        multi_match: {
          query: 'alice',
          fields: ['name', 'aliases', 'notes'],
          fuzziness: 'AUTO',
        },
      });
    });

    it('uses default pagination (size=50, from=0)', async () => {
      await repo.list(USER_ID, {});

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 50, from: 0 }),
      );
    });

    it('applies custom limit and offset', async () => {
      await repo.list(USER_ID, { limit: 10, offset: 20 });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 10, from: 20 }),
      );
    });

    it('sorts by updated_at desc when no free-text query', async () => {
      await repo.list(USER_ID, {});

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.sort).toEqual([{ updated_at: { order: 'desc' } }]);
    });

    it('drops explicit sort (delegates to relevance) when free-text query is given', async () => {
      await repo.list(USER_ID, { query: 'alice' });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      expect(call.sort).toBeUndefined();
    });

    it('parses search response and maps hits to camelCase persons', async () => {
      const client = makeEsClient({
        searchResult: {
          hits: {
            total: { value: 2 },
            hits: [
              {
                _id: 'p-100',
                _score: 1.0,
                _source: {
                  user_id: USER_ID,
                  name: 'Alice',
                  aliases: ['Ali'],
                  relationship: 'friend',
                  contact_info: { email: 'alice@example.com' },
                  tags: ['tennis'],
                  notes: 'Met at conference',
                  status: 'full',
                  created_at: '2025-01-01T00:00:00Z',
                  updated_at: '2025-06-01T00:00:00Z',
                },
              },
              {
                _id: 'p-101',
                _score: 0.8,
                _source: {
                  user_id: USER_ID,
                  name: 'Bob',
                  aliases: [],
                  relationship: 'colleague',
                  tags: [],
                  status: 'contact-only',
                  created_at: '2025-02-01T00:00:00Z',
                  updated_at: '2025-07-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.list(USER_ID, {});

      expect(result.total).toBe(2);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toEqual({
        id: 'p-100',
        userId: USER_ID,
        name: 'Alice',
        aliases: ['Ali'],
        relationship: 'friend',
        contactInfo: { email: 'alice@example.com' },
        tags: ['tennis'],
        notes: 'Met at conference',
        status: 'full',
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-06-01T00:00:00Z',
      });
      expect(result.items[1].status).toBe('contact-only');
    });

    it('defaults missing aliases/tags to empty arrays and missing status to "full"', async () => {
      const client = makeEsClient({
        searchResult: {
          hits: {
            total: { value: 1 },
            hits: [
              {
                _id: 'p-minimal',
                _source: {
                  user_id: USER_ID,
                  name: 'Minimal',
                  // intentionally no aliases, tags, status, relationship
                  created_at: '2025-01-01T00:00:00Z',
                  updated_at: '2025-01-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.list(USER_ID, {});
      expect(result.items[0].aliases).toEqual([]);
      expect(result.items[0].tags).toEqual([]);
      expect(result.items[0].relationship).toBe('');
      expect(result.items[0].status).toBe('full');
      expect(result.items[0].notes).toBeUndefined();
      expect(result.items[0].contactInfo).toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns null when document not found (404)', async () => {
      const client = makeEsClient();
      vi.mocked(client.get).mockRejectedValue({ meta: { statusCode: 404 } });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.get(USER_ID, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when user_id does not match (cross-tenant safety)', async () => {
      const client = makeEsClient({
        getResult: {
          _id: 'p-1',
          _source: {
            user_id: 'someone-else',
            name: 'Not Yours',
            aliases: [],
            relationship: '',
            tags: [],
            status: 'full',
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-01-01T00:00:00Z',
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.get(USER_ID, 'p-1');
      expect(result).toBeNull();
    });

    it('returns mapped person when user_id matches', async () => {
      const client = makeEsClient({
        getResult: {
          _id: 'p-1',
          _source: {
            user_id: USER_ID,
            name: 'Alice',
            aliases: ['Ali'],
            relationship: 'friend',
            tags: ['tennis'],
            status: 'full',
            created_at: '2025-01-01T00:00:00Z',
            updated_at: '2025-06-01T00:00:00Z',
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.get(USER_ID, 'p-1');
      expect(result).not.toBeNull();
      expect(result!.id).toBe('p-1');
      expect(result!.userId).toBe(USER_ID);
      expect(result!.name).toBe('Alice');
      expect(result!.status).toBe('full');
    });
  });

  describe('upsert', () => {
    it('creates a new person document when no id is provided', async () => {
      const result = await repo.upsert(USER_ID, {
        name: 'New Person',
        relationship: 'friend',
        tags: ['new'],
        status: 'full',
      });

      expect(result.created).toBe(true);
      expect(result.person.name).toBe('New Person');
      expect(result.person.status).toBe('full');

      const indexCall = vi.mocked(esClient.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.index).toBe('ll5_knowledge_people');
      expect(indexCall.id).toBeDefined();
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.user_id).toBe(USER_ID);
      expect(doc.name).toBe('New Person');
      expect(doc.status).toBe('full');
      expect(doc.created_at).toBeDefined();
      expect(doc.updated_at).toBeDefined();
    });

    it('updates an existing person, merging unspecified fields from prior doc', async () => {
      const existingDoc = {
        user_id: USER_ID,
        name: 'Existing',
        aliases: ['Ex'],
        relationship: 'colleague',
        tags: ['work'],
        notes: 'Old notes',
        status: 'full',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-06-01T00:00:00Z',
      };
      const client = makeEsClient({
        getResult: { _id: 'p-existing', _source: existingDoc },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.upsert(USER_ID, {
        id: 'p-existing',
        name: 'Existing Updated',
        notes: 'New notes',
      });

      expect(result.created).toBe(false);
      expect(result.person.name).toBe('Existing Updated');
      expect(result.person.notes).toBe('New notes');
      // preserved
      expect(result.person.aliases).toEqual(['Ex']);
      expect(result.person.relationship).toBe('colleague');
      expect(result.person.tags).toEqual(['work']);
      expect(result.person.status).toBe('full');
      expect(result.person.createdAt).toBe('2024-01-01T00:00:00Z');

      const indexCall = vi.mocked(client.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.id).toBe('p-existing');
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.created_at).toBe('2024-01-01T00:00:00Z');
      // updated_at should be refreshed (different from existing)
      expect(doc.updated_at).not.toBe('2024-06-01T00:00:00Z');
    });

    it('preserves existing status when not specified in update', async () => {
      const client = makeEsClient({
        getResult: {
          _id: 'p-co',
          _source: {
            user_id: USER_ID,
            name: 'CO',
            aliases: [],
            relationship: '',
            tags: [],
            status: 'contact-only',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.upsert(USER_ID, { id: 'p-co', name: 'CO renamed' });
      expect(result.person.status).toBe('contact-only');
    });

    it('overrides existing status when explicitly provided', async () => {
      const client = makeEsClient({
        getResult: {
          _id: 'p-co',
          _source: {
            user_id: USER_ID,
            name: 'CO',
            aliases: [],
            relationship: '',
            tags: [],
            status: 'contact-only',
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const result = await r.upsert(USER_ID, {
        id: 'p-co',
        name: 'CO promoted',
        status: 'full',
      });
      expect(result.person.status).toBe('full');
    });

    it('defaults status to "full" for new persons without status', async () => {
      const result = await repo.upsert(USER_ID, { name: 'Brand New' });
      expect(result.person.status).toBe('full');
      const indexCall = vi.mocked(esClient.index).mock.calls[0][0] as Record<string, unknown>;
      const doc = indexCall.document as Record<string, unknown>;
      expect(doc.status).toBe('full');
    });

    it('treats upsert with id but no existing doc as a create (created=true)', async () => {
      // get() returns _source: null → effectively missing
      const result = await repo.upsert(USER_ID, { id: 'p-fresh-id', name: 'Forced ID' });
      expect(result.created).toBe(true);
      const indexCall = vi.mocked(esClient.index).mock.calls[0][0] as Record<string, unknown>;
      expect(indexCall.id).toBe('p-fresh-id');
    });
  });

  describe('delete', () => {
    it('uses deleteByQuery scoped by _id and user_id (cross-tenant safe)', async () => {
      const client = makeEsClient({ deleteByQueryResult: { deleted: 1 } });
      const r = new ElasticsearchPersonRepository(client);

      const ok = await r.delete(USER_ID, 'p-del');
      expect(ok).toBe(true);

      const call = vi.mocked(client.deleteByQuery).mock.calls[0][0] as Record<string, unknown>;
      expect(call.index).toBe('ll5_knowledge_people');
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { _id: 'p-del' } });
      expect(filters).toContainEqual({ term: { user_id: USER_ID } });
      expect(call.refresh).toBe(true);
    });

    it('returns false when nothing was deleted', async () => {
      const client = makeEsClient({ deleteByQueryResult: { deleted: 0 } });
      const r = new ElasticsearchPersonRepository(client);

      const ok = await r.delete(USER_ID, 'nonexistent');
      expect(ok).toBe(false);
    });
  });

  describe('search', () => {
    it('uses multi_match with boosted name/aliases and highlight config', async () => {
      await repo.search(USER_ID, 'alice');

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const must = bool.must as Array<Record<string, unknown>>;
      expect(must[0]).toEqual({
        multi_match: {
          query: 'alice',
          fields: ['name^2', 'aliases^2', 'notes'],
          fuzziness: 'AUTO',
        },
      });
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { user_id: USER_ID } });

      expect(call.highlight).toEqual({
        fields: { name: {}, aliases: {}, notes: {} },
        pre_tags: ['<em>'],
        post_tags: ['</em>'],
      });
    });

    it('honors custom limit', async () => {
      await repo.search(USER_ID, 'alice', 5);
      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 5 }),
      );
    });

    it('uses default limit of 20', async () => {
      await repo.search(USER_ID, 'alice');
      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 20 }),
      );
    });

    it('maps hits to SearchResult with normalized score and highlight fallback', async () => {
      const client = makeEsClient({
        searchResult: {
          hits: {
            total: { value: 2 },
            hits: [
              {
                _id: 'p-1',
                _score: 2.0,
                _source: {
                  user_id: USER_ID,
                  name: 'Alice',
                  aliases: ['Ali'],
                  relationship: 'friend',
                  tags: [],
                  status: 'full',
                  created_at: '2025-01-01T00:00:00Z',
                  updated_at: '2025-06-01T00:00:00Z',
                },
                highlight: { name: ['<em>Alice</em>'] },
              },
              {
                _id: 'p-2',
                _score: 1.0,
                _source: {
                  user_id: USER_ID,
                  name: 'Alicia',
                  aliases: [],
                  relationship: '',
                  tags: [],
                  status: 'full',
                  created_at: '2025-01-01T00:00:00Z',
                  updated_at: '2025-06-01T00:00:00Z',
                },
              },
            ],
          },
        },
      });
      const r = new ElasticsearchPersonRepository(client);

      const results = await r.search(USER_ID, 'alice');
      expect(results).toHaveLength(2);
      expect(results[0].entityType).toBe('person');
      expect(results[0].entityId).toBe('p-1');
      expect(results[0].score).toBe(1); // 2.0 / 2.0 max
      expect(results[0].highlight).toBe('<em>Alice</em>');
      expect(results[0].summary).toBe('Alice (friend)');

      expect(results[1].score).toBe(0.5); // 1.0 / 2.0 max
      expect(results[1].highlight).toBe('Alicia'); // falls back to person name
      expect(results[1].summary).toBe('Alicia'); // no relationship → no parens
    });
  });
});
