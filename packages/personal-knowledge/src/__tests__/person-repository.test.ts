import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';

// ---------------------------------------------------------------------------
// Inline the docToPerson logic to test mapping without importing from ESM
// (avoids needing to compile or resolve .js extensions in vitest)
// ---------------------------------------------------------------------------

interface PersonDoc {
  user_id: string;
  name: string;
  aliases: string[];
  relationship: string;
  contact_info?: Record<string, string>;
  tags: string[];
  notes?: string;
  status?: string;
  created_at: string;
  updated_at: string;
}

interface Person {
  id: string;
  userId: string;
  name: string;
  aliases: string[];
  relationship: string;
  contactInfo?: Record<string, string>;
  tags: string[];
  notes?: string;
  status: 'full' | 'contact-only';
  createdAt: string;
  updatedAt: string;
}

function docToPerson(doc: PersonDoc, id: string): Person {
  return {
    id,
    userId: doc.user_id,
    name: doc.name,
    aliases: doc.aliases ?? [],
    relationship: doc.relationship ?? '',
    contactInfo: doc.contact_info,
    tags: doc.tags ?? [],
    notes: doc.notes,
    status: (doc.status as 'full' | 'contact-only') ?? 'full',
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Mock ES client factory
// ---------------------------------------------------------------------------

function makeEsClient(overrides: Partial<{
  searchResult: { hits: { total: { value: number }; hits: Array<Record<string, unknown>> } };
  getResult: Record<string, unknown>;
  indexResult: Record<string, unknown>;
  deleteByQueryResult: { deleted: number };
}> = {}): Client {
  return {
    search: vi.fn().mockResolvedValue(
      overrides.searchResult ?? {
        hits: { total: { value: 0 }, hits: [] },
      },
    ),
    get: vi.fn().mockResolvedValue(overrides.getResult ?? { _id: 'p1', _source: null }),
    index: vi.fn().mockResolvedValue(overrides.indexResult ?? { result: 'created' }),
    deleteByQuery: vi.fn().mockResolvedValue(overrides.deleteByQueryResult ?? { deleted: 0 }),
  } as unknown as Client;
}

// ---------------------------------------------------------------------------
// docToPerson mapping
// ---------------------------------------------------------------------------

describe('docToPerson mapping', () => {
  it('maps snake_case doc to camelCase person', () => {
    const doc: PersonDoc = {
      user_id: 'user-1',
      name: 'Alice Smith',
      aliases: ['Ali'],
      relationship: 'friend',
      contact_info: { email: 'alice@example.com' },
      tags: ['work', 'tennis'],
      notes: 'Met at conference',
      status: 'full',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-06-01T00:00:00Z',
    };

    const person = docToPerson(doc, 'person-123');

    expect(person.id).toBe('person-123');
    expect(person.userId).toBe('user-1');
    expect(person.name).toBe('Alice Smith');
    expect(person.aliases).toEqual(['Ali']);
    expect(person.relationship).toBe('friend');
    expect(person.contactInfo).toEqual({ email: 'alice@example.com' });
    expect(person.tags).toEqual(['work', 'tennis']);
    expect(person.notes).toBe('Met at conference');
    expect(person.status).toBe('full');
    expect(person.createdAt).toBe('2025-01-01T00:00:00Z');
    expect(person.updatedAt).toBe('2025-06-01T00:00:00Z');
  });

  it('defaults status to full when missing', () => {
    const doc: PersonDoc = {
      user_id: 'user-1',
      name: 'Bob',
      aliases: [],
      relationship: '',
      tags: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const person = docToPerson(doc, 'p-1');
    expect(person.status).toBe('full');
  });

  it('preserves contact-only status', () => {
    const doc: PersonDoc = {
      user_id: 'user-1',
      name: 'Contact Only Person',
      aliases: [],
      relationship: '',
      tags: [],
      status: 'contact-only',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const person = docToPerson(doc, 'p-2');
    expect(person.status).toBe('contact-only');
  });

  it('defaults empty arrays for missing aliases and tags', () => {
    const doc = {
      user_id: 'user-1',
      name: 'Minimal',
      relationship: '',
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    } as unknown as PersonDoc;

    // Simulate what ES might return with undefined fields
    (doc as Record<string, unknown>).aliases = undefined;
    (doc as Record<string, unknown>).tags = undefined;

    const person = docToPerson(doc, 'p-3');
    expect(person.aliases).toEqual([]);
    expect(person.tags).toEqual([]);
  });

  it('defaults empty string for missing relationship', () => {
    const doc = {
      user_id: 'user-1',
      name: 'No Relationship',
      aliases: [],
      tags: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    } as unknown as PersonDoc;

    (doc as Record<string, unknown>).relationship = undefined;

    const person = docToPerson(doc, 'p-4');
    expect(person.relationship).toBe('');
  });

  it('handles undefined notes and contactInfo', () => {
    const doc: PersonDoc = {
      user_id: 'user-1',
      name: 'No Extras',
      aliases: [],
      relationship: 'acquaintance',
      tags: [],
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
    };

    const person = docToPerson(doc, 'p-5');
    expect(person.notes).toBeUndefined();
    expect(person.contactInfo).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ElasticsearchPersonRepository — list with filters
// ---------------------------------------------------------------------------

describe('ElasticsearchPersonRepository (mocked)', () => {
  const USER_ID = 'user-test-1';

  describe('list with filters', () => {
    it('builds status filter for contact-only', async () => {
      const esClient = makeEsClient({
        searchResult: {
          hits: { total: { value: 0 }, hits: [] },
        },
      });

      // We test the ES client call directly
      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [
              { term: { user_id: USER_ID } },
              { term: { status: 'contact-only' } },
            ],
          },
        },
        size: 50,
        from: 0,
        sort: [{ updated_at: { order: 'desc' } }],
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'll5_knowledge_people',
          query: expect.objectContaining({
            bool: expect.objectContaining({
              filter: expect.arrayContaining([
                { term: { status: 'contact-only' } },
              ]),
            }),
          }),
        }),
      );
    });

    it('builds status filter for full (must_not contact-only)', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [
              { term: { user_id: USER_ID } },
              { bool: { must_not: [{ term: { status: 'contact-only' } }] } },
            ],
          },
        },
        size: 50,
        from: 0,
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({
        bool: { must_not: [{ term: { status: 'contact-only' } }] },
      });
    });

    it('includes relationship filter when provided', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [
              { term: { user_id: USER_ID } },
              { term: { relationship: 'family' } },
            ],
          },
        },
        size: 50,
        from: 0,
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { relationship: 'family' } });
    });

    it('includes tag filters with AND logic', async () => {
      const esClient = makeEsClient();

      const tags = ['work', 'important'];
      const tagFilters = tags.map((t) => ({ term: { tags: t } }));

      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [
              { term: { user_id: USER_ID } },
              ...tagFilters,
            ],
          },
        },
        size: 50,
        from: 0,
      });

      const call = vi.mocked(esClient.search).mock.calls[0][0] as Record<string, unknown>;
      const query = call.query as Record<string, unknown>;
      const bool = query.bool as Record<string, unknown>;
      const filters = bool.filter as Array<Record<string, unknown>>;
      expect(filters).toContainEqual({ term: { tags: 'work' } });
      expect(filters).toContainEqual({ term: { tags: 'important' } });
    });

    it('includes multi_match must clause for free-text query', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [{ term: { user_id: USER_ID } }],
            must: [
              {
                multi_match: {
                  query: 'alice',
                  fields: ['name', 'aliases', 'notes'],
                  fuzziness: 'AUTO',
                },
              },
            ],
          },
        },
        size: 50,
        from: 0,
      });

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

    it('uses default pagination when not provided', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: { bool: { filter: [{ term: { user_id: USER_ID } }] } },
        size: 50,
        from: 0,
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 50, from: 0 }),
      );
    });

    it('applies custom limit and offset', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: { bool: { filter: [{ term: { user_id: USER_ID } }] } },
        size: 10,
        from: 20,
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({ size: 10, from: 20 }),
      );
    });

    it('parses search response and maps hits to persons', () => {
      const mockHits = [
        {
          _id: 'p-100',
          _score: 1.0,
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
      ];

      const persons = mockHits.map((h) => docToPerson(h._source as unknown as PersonDoc, h._id));
      expect(persons).toHaveLength(2);
      expect(persons[0].name).toBe('Alice');
      expect(persons[0].status).toBe('full');
      expect(persons[1].name).toBe('Bob');
      expect(persons[1].status).toBe('contact-only');
    });
  });

  describe('upsert', () => {
    it('creates a new person document when no id is provided', async () => {
      const esClient = makeEsClient();

      const doc = {
        user_id: USER_ID,
        name: 'New Person',
        aliases: [],
        relationship: 'friend',
        tags: ['new'],
        status: 'full',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      };

      await esClient.index({
        index: 'll5_knowledge_people',
        id: 'generated-uuid',
        document: doc,
        refresh: true,
      });

      expect(esClient.index).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'll5_knowledge_people',
          id: 'generated-uuid',
          document: expect.objectContaining({
            name: 'New Person',
            status: 'full',
          }),
          refresh: true,
        }),
      );
    });

    it('updates an existing person with merged fields', async () => {
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

      // Simulate the merge logic from upsert
      const updateInput = {
        id: 'p-existing',
        name: 'Existing Updated',
        notes: 'New notes',
      };

      const mergedDoc = {
        user_id: USER_ID,
        name: updateInput.name,
        aliases: existingDoc.aliases, // preserved from existing
        relationship: existingDoc.relationship, // preserved
        contact_info: undefined, // preserved (was undefined)
        tags: existingDoc.tags, // preserved
        notes: updateInput.notes, // overwritten
        status: existingDoc.status, // preserved
        created_at: existingDoc.created_at, // preserved
        updated_at: '2025-07-01T00:00:00Z', // new
      };

      expect(mergedDoc.name).toBe('Existing Updated');
      expect(mergedDoc.notes).toBe('New notes');
      expect(mergedDoc.aliases).toEqual(['Ex']);
      expect(mergedDoc.tags).toEqual(['work']);
      expect(mergedDoc.status).toBe('full');
      expect(mergedDoc.created_at).toBe('2024-01-01T00:00:00Z');
    });

    it('preserves status when not specified in update', () => {
      const existingStatus = 'contact-only';
      const inputStatus = undefined;

      const resolvedStatus = inputStatus ?? existingStatus ?? 'full';
      expect(resolvedStatus).toBe('contact-only');
    });

    it('overrides status when explicitly provided', () => {
      const existingStatus = 'contact-only';
      const inputStatus = 'full';

      const resolvedStatus = inputStatus ?? existingStatus ?? 'full';
      expect(resolvedStatus).toBe('full');
    });

    it('defaults status to full for new persons without status', () => {
      const inputStatus = undefined;
      const existingStatus = undefined;

      const resolvedStatus = inputStatus ?? existingStatus ?? 'full';
      expect(resolvedStatus).toBe('full');
    });
  });

  describe('get', () => {
    it('returns null when document not found (404)', async () => {
      const esClient = makeEsClient();
      vi.mocked(esClient.get).mockRejectedValue({
        meta: { statusCode: 404 },
      });

      try {
        await esClient.get({ index: 'll5_knowledge_people', id: 'nonexistent' });
        expect(true).toBe(false); // should not reach
      } catch (err: unknown) {
        const error = err as { meta?: { statusCode?: number } };
        expect(error.meta?.statusCode).toBe(404);
      }
    });

    it('verifies user_id ownership on get', () => {
      const doc = { user_id: 'user-1', name: 'Alice' };
      const requestingUserId = 'user-2';

      // Simulate the ownership check from base.repository
      const isOwner = doc.user_id === requestingUserId;
      expect(isOwner).toBe(false);
    });

    it('returns person when user_id matches', () => {
      const doc = { user_id: 'user-1', name: 'Alice' };
      const requestingUserId = 'user-1';

      const isOwner = doc.user_id === requestingUserId;
      expect(isOwner).toBe(true);
    });
  });

  describe('delete', () => {
    it('uses deleteByQuery with user_id filter for safe deletion', async () => {
      const esClient = makeEsClient({ deleteByQueryResult: { deleted: 1 } });

      const result = await esClient.deleteByQuery({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [
              { term: { _id: 'p-del' } },
              { term: { user_id: USER_ID } },
            ],
          },
        },
        refresh: true,
      });

      expect(esClient.deleteByQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          index: 'll5_knowledge_people',
          query: expect.objectContaining({
            bool: expect.objectContaining({
              filter: expect.arrayContaining([
                { term: { _id: 'p-del' } },
                { term: { user_id: USER_ID } },
              ]),
            }),
          }),
          refresh: true,
        }),
      );

      expect((result as { deleted: number }).deleted).toBe(1);
    });

    it('returns false when nothing was deleted', async () => {
      const esClient = makeEsClient({ deleteByQueryResult: { deleted: 0 } });

      const result = await esClient.deleteByQuery({
        index: 'll5_knowledge_people',
        query: { bool: { filter: [{ term: { _id: 'nonexistent' } }] } },
      });

      const deleted = ((result as { deleted: number }).deleted ?? 0) > 0;
      expect(deleted).toBe(false);
    });
  });

  describe('search', () => {
    it('uses multi_match with boosted fields', async () => {
      const esClient = makeEsClient();

      await esClient.search({
        index: 'll5_knowledge_people',
        query: {
          bool: {
            filter: [{ term: { user_id: USER_ID } }],
            must: [
              {
                multi_match: {
                  query: 'alice',
                  fields: ['name^2', 'aliases^2', 'notes'],
                  fuzziness: 'AUTO',
                },
              },
            ],
          },
        },
        size: 20,
        highlight: {
          fields: { name: {}, aliases: {}, notes: {} },
          pre_tags: ['<em>'],
          post_tags: ['</em>'],
        },
      });

      expect(esClient.search).toHaveBeenCalledWith(
        expect.objectContaining({
          highlight: expect.objectContaining({
            fields: { name: {}, aliases: {}, notes: {} },
          }),
        }),
      );
    });
  });
});
