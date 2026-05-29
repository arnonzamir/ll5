import { describe, it, expect, vi } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import { registerSearchTools } from '../tools/search.js';
import { ElasticsearchFactRepository } from '../repositories/elasticsearch/fact.repository.js';
import { ElasticsearchPersonRepository } from '../repositories/elasticsearch/person.repository.js';
import { ElasticsearchPlaceRepository } from '../repositories/elasticsearch/place.repository.js';
import { captureTools, parseToolResponse } from './_helpers.js';

const USER_ID = 'user-test-1';

interface MergedResult {
  entity_type: 'fact' | 'person' | 'place';
  entity_id: string;
  score: number;
  highlight: string;
  summary: string;
  data: unknown;
}

/**
 * Build a single mock ES Client whose `search` returns a different response per
 * index. This lets us drive the three real repositories (fact/person/place)
 * through the real `search_knowledge` tool and observe cross-entity ranking.
 */
function makeMultiIndexClient(byIndex: Record<string, unknown>): Client {
  return {
    search: vi.fn(async (params: { index: string }) => {
      return byIndex[params.index] ?? { hits: { total: { value: 0 }, hits: [] } };
    }),
  } as unknown as Client;
}

function factHit(id: string, score: number, content: string) {
  return {
    _id: id,
    _score: score,
    _source: {
      user_id: USER_ID,
      type: 'attribute',
      category: 'misc',
      content,
      provenance: 'stated',
      confidence: 0.9,
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  };
}

function personHit(id: string, score: number, name: string) {
  return {
    _id: id,
    _score: score,
    _source: {
      user_id: USER_ID,
      name,
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  };
}

function placeHit(id: string, score: number, name: string) {
  return {
    _id: id,
    _score: score,
    _source: {
      user_id: USER_ID,
      name,
      type: 'other',
      tags: [],
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  };
}

function buildTool(client: Client) {
  const factRepo = new ElasticsearchFactRepository(client);
  const personRepo = new ElasticsearchPersonRepository(client);
  const placeRepo = new ElasticsearchPlaceRepository(client);
  const tools = captureTools((server) =>
    registerSearchTools(server, factRepo, personRepo, placeRepo, () => USER_ID),
  );
  return tools.get('search_knowledge')!;
}

describe('search_knowledge cross-entity ranking', () => {
  it('orders results by real relative relevance across entity types', async () => {
    // Raw ES BM25 scores: the person is the single most relevant hit overall,
    // a fact is second, the place is least relevant. Within facts there are two
    // hits so the per-repo top is NOT the global top.
    const client = makeMultiIndexClient({
      ll5_knowledge_facts: {
        hits: {
          total: { value: 2 },
          hits: [factHit('f1', 8.0, 'fact one'), factHit('f2', 2.0, 'fact two')],
        },
      },
      ll5_knowledge_people: {
        hits: { total: { value: 1 }, hits: [personHit('p1', 12.0, 'Person One')] },
      },
      ll5_knowledge_places: {
        hits: { total: { value: 1 }, hits: [placeHit('pl1', 1.0, 'Place One')] },
      },
    });

    const handler = buildTool(client);
    // min_score 0 so all four survive and we can assert the full ordering.
    const res = await handler({ query: 'one', min_score: 0 });
    const { results } = parseToolResponse<{ results: MergedResult[] }>(res);

    // Real relevance order: person(12) > fact f1(8) > fact f2(2) > place(1).
    expect(results.map((r) => r.entity_id)).toEqual(['p1', 'f1', 'f2', 'pl1']);
    expect(results[0].entity_type).toBe('person');
  });

  it('does not collapse every entity type top hit to the same score', async () => {
    const client = makeMultiIndexClient({
      ll5_knowledge_facts: {
        hits: { total: { value: 1 }, hits: [factHit('f1', 8.0, 'fact one')] },
      },
      ll5_knowledge_people: {
        hits: { total: { value: 1 }, hits: [personHit('p1', 12.0, 'Person One')] },
      },
      ll5_knowledge_places: {
        hits: { total: { value: 1 }, hits: [placeHit('pl1', 1.0, 'Place One')] },
      },
    });

    const handler = buildTool(client);
    // min_score 0 so the weak place survives and we can compare all scores.
    const res = await handler({ query: 'one', min_score: 0 });
    const { results } = parseToolResponse<{ results: MergedResult[] }>(res);

    const scores = results.map((r) => r.score);
    // The three top-of-type hits must NOT all be 1.0 — they have very different
    // real relevance. With per-repo normalization they would all be 1.0.
    const distinct = new Set(scores);
    expect(distinct.size).toBeGreaterThan(1);

    // Person is the global best so it should be the highest score.
    const person = results.find((r) => r.entity_id === 'p1')!;
    const place = results.find((r) => r.entity_id === 'pl1')!;
    expect(person.score).toBeGreaterThan(place.score);
  });

  it('applies min_score meaningfully against cross-entity relevance', async () => {
    // place is far less relevant than the others; a moderate min_score should
    // drop it but keep the genuinely relevant fact + person.
    const client = makeMultiIndexClient({
      ll5_knowledge_facts: {
        hits: { total: { value: 1 }, hits: [factHit('f1', 8.0, 'fact one')] },
      },
      ll5_knowledge_people: {
        hits: { total: { value: 1 }, hits: [personHit('p1', 12.0, 'Person One')] },
      },
      ll5_knowledge_places: {
        hits: { total: { value: 1 }, hits: [placeHit('pl1', 1.0, 'Place One')] },
      },
    });

    const handler = buildTool(client);
    const res = await handler({ query: 'one', min_score: 0.5 });
    const { results } = parseToolResponse<{ results: MergedResult[] }>(res);

    const ids = results.map((r) => r.entity_id);
    expect(ids).toContain('p1');
    expect(ids).toContain('f1');
    // The weakly-relevant place (1/12 ≈ 0.083) is below the 0.5 threshold and
    // must be filtered out. Per-repo normalization would make it 1.0 and keep it.
    expect(ids).not.toContain('pl1');
  });
});
