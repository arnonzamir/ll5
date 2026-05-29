import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactRepository } from '../repositories/interfaces/fact.repository.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import type { SearchResult } from '../types/search.js';
import type { Fact } from '../types/fact.js';
import type { Person } from '../types/person.js';
import type { Place } from '../types/place.js';
import { logger } from '../utils/logger.js';

export function registerSearchTools(
  server: McpServer,
  factRepo: FactRepository,
  personRepo: PersonRepository,
  placeRepo: PlaceRepository,
  getUserId: () => string,
): void {
  server.tool(
    'search_knowledge',
    'Full-text fuzzy search across all knowledge entities (facts, people, places). Results are relevance-scored and unified.',
    {
      query: z.string().describe('Free-text search query (Hebrew or English)'),
      entity_types: z
        .array(z.enum(['fact', 'person', 'place']))
        .optional()
        .describe('Filter to specific types. Default: all.'),
      limit: z.number().min(1).max(100).optional().describe('Max results. Default: 20.'),
      min_score: z.number().min(0).max(1).optional().describe('Minimum relevance score (0.0-1.0). Default: 0.1.'),
      tags: z.array(z.string()).optional().describe('Filter results that have ALL of these tags'),
    },
    async (params) => {
      const userId = getUserId();
      const limit = params.limit ?? 20;
      const minScore = params.min_score ?? 0.1;
      const entityTypes = params.entity_types ?? ['fact', 'person', 'place'];

      const searches: Array<Promise<SearchResult<Fact | Person | Place>[]>> = [];

      if (entityTypes.includes('fact')) {
        searches.push(
          factRepo
            .search(userId, params.query, limit)
            .catch((err) => {
              logger.error('[search][searchKnowledge] Fact search failed', { error: String(err) });
              return [] as SearchResult<Fact>[];
            }) as Promise<SearchResult<Fact | Person | Place>[]>,
        );
      }
      if (entityTypes.includes('person')) {
        searches.push(
          personRepo
            .search(userId, params.query, limit)
            .catch((err) => {
              logger.error('[search][searchKnowledge] Person search failed', { error: String(err) });
              return [] as SearchResult<Person>[];
            }) as Promise<SearchResult<Fact | Person | Place>[]>,
        );
      }
      if (entityTypes.includes('place')) {
        searches.push(
          placeRepo
            .search(userId, params.query, limit)
            .catch((err) => {
              logger.error('[search][searchKnowledge] Place search failed', { error: String(err) });
              return [] as SearchResult<Place>[];
            }) as Promise<SearchResult<Fact | Person | Place>[]>,
        );
      }

      const searchResults = await Promise.all(searches);
      let merged = searchResults.flat();

      // Repos carry raw BM25 _score, which is comparable across entity types
      // for the same query (same multi_match + fuzziness). Normalize against
      // the single global max across ALL entity types so the resulting score
      // is a comparable 0..1 relevance and min_score (0..1) is meaningful.
      // Per-repo normalization would make every type's top hit 1.0 and break
      // cross-entity ranking.
      const globalMax = merged.reduce((m, r) => (r.score > m ? r.score : m), 0);
      logger.info('[search][searchKnowledge] Scoring basis', {
        scoringBasis: 'raw_bm25_global_normalized',
        globalMax,
        candidates: merged.length,
      });
      merged = merged.map((r) => ({
        ...r,
        score: globalMax > 0 ? r.score / globalMax : 0,
      }));

      // Filter by min score
      merged = merged.filter((r) => r.score >= minScore);

      // Filter by tags if specified
      if (params.tags && params.tags.length > 0) {
        const requiredTags = new Set(params.tags);
        merged = merged.filter((r) => {
          const data = r.data as { tags?: string[] };
          if (!data.tags) return false;
          return [...requiredTags].every((t) => data.tags!.includes(t));
        });
      }

      // Sort by score descending
      merged.sort((a, b) => b.score - a.score);

      // Apply limit
      merged = merged.slice(0, limit);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              results: merged.map((r) => ({
                entity_type: r.entityType,
                entity_id: r.entityId,
                score: r.score,
                highlight: r.highlight,
                summary: r.summary,
                data: r.data,
              })),
              total: merged.length,
            }),
          },
        ],
      };
    },
  );
}
