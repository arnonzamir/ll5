import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { FactRepository } from '../repositories/interfaces/fact.repository.js';
import { FACT_TYPES, PROVENANCE_VALUES } from '../types/fact.js';

export function registerFactTools(
  server: McpServer,
  factRepo: FactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_facts',
    'List facts with optional filters. Sorted by updated_at descending.',
    {
      type: z.enum(FACT_TYPES).optional().describe('Filter by fact type'),
      category: z.string().optional().describe('Filter by category'),
      provenance: z.enum(PROVENANCE_VALUES).optional().describe('Filter by provenance'),
      min_confidence: z.number().min(0).max(1).optional().describe('Minimum confidence score'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
      query: z.string().optional().describe('Free-text search within facts'),
      limit: z.number().min(1).max(200).optional().describe('Max results. Default: 50'),
      offset: z.number().min(0).optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await factRepo.list(userId, {
        type: params.type,
        category: params.category,
        provenance: params.provenance,
        minConfidence: params.min_confidence,
        tags: params.tags,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ facts: result.items, total: result.total }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_fact',
    'Retrieve a single fact by ID.',
    {
      id: z.string().describe('Fact ID'),
    },
    async (params) => {
      const userId = getUserId();
      const fact = await factRepo.get(userId, params.id);
      if (!fact) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Fact not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ fact }) }],
      };
    },
  );

  server.tool(
    'upsert_fact',
    'Create a new fact or update an existing one. If id is provided, updates that fact.',
    {
      id: z.string().optional().describe('Fact ID to update. Omit to create new.'),
      type: z.enum(FACT_TYPES).describe('Fact type'),
      category: z.string().describe('Free-text category (e.g. food, work, family)'),
      content: z.string().describe('The fact itself, in natural language'),
      provenance: z.enum(PROVENANCE_VALUES).describe('How this fact was learned'),
      confidence: z.number().min(0).max(1).describe('Confidence score 0.0-1.0'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      source: z.string().optional().describe('Where this fact was learned'),
      valid_from: z.string().optional().describe('ISO 8601 date when this fact became true'),
      valid_until: z.string().optional().describe('ISO 8601 date when this fact expires'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await factRepo.upsert(userId, {
        id: params.id,
        type: params.type,
        category: params.category,
        content: params.content,
        provenance: params.provenance,
        confidence: params.confidence,
        tags: params.tags,
        source: params.source,
        validFrom: params.valid_from,
        validUntil: params.valid_until,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ fact: result.fact, created: result.created }),
          },
        ],
      };
    },
  );

  server.tool(
    'delete_fact',
    'Delete a fact by ID.',
    {
      id: z.string().describe('Fact ID'),
    },
    async (params) => {
      const userId = getUserId();
      const deleted = await factRepo.delete(userId, params.id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Fact not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }) }],
      };
    },
  );
}
