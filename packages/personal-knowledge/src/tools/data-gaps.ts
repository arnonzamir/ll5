import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataGapRepository } from '../repositories/interfaces/data-gap.repository.js';
import { DATA_GAP_STATUSES } from '../types/data-gap.js';
import { logAudit } from '@ll5/shared';

export function registerDataGapTools(
  server: McpServer,
  dataGapRepo: DataGapRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_data_gaps',
    'List known gaps in the knowledge base -- things the system wants to learn about the user.',
    {
      status: z.enum(DATA_GAP_STATUSES).optional().describe('Filter by status. Default: open.'),
      min_priority: z.number().min(1).max(10).optional().describe('Minimum priority (1-10). Default: 1.'),
      limit: z.number().min(1).max(200).optional().describe('Max results. Default: 50'),
      offset: z.number().min(0).optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await dataGapRepo.list(userId, {
        status: params.status ?? 'open',
        minPriority: params.min_priority,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ data_gaps: result.items, total: result.total }),
          },
        ],
      };
    },
  );

  server.tool(
    'upsert_data_gap',
    'Create or update a data gap (a question representing a knowledge gap).',
    {
      id: z.string().optional().describe('Data gap ID to update. Omit to create new.'),
      question: z.string().describe('The question representing the knowledge gap'),
      priority: z.number().min(1).max(10).optional().describe('Priority 1-10 (10 = most important)'),
      status: z.enum(DATA_GAP_STATUSES).optional().describe('Status: open, answered, dismissed'),
      context: z.string().optional().describe('Why this gap matters'),
      answer: z.string().optional().describe('The answer, when resolving the gap'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await dataGapRepo.upsert(userId, {
        id: params.id,
        question: params.question,
        priority: params.priority,
        status: params.status,
        context: params.context,
        answer: params.answer,
      });

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: result.created ? 'create' : 'update',
        entity_type: 'data_gap',
        entity_id: result.dataGap.id,
        summary: `${result.created ? 'Created' : 'Updated'} data gap: ${params.question.slice(0, 100)}`,
        metadata: { status: params.status, priority: params.priority },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ data_gap: result.dataGap, created: result.created }),
          },
        ],
      };
    },
  );
}
