import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { EntityStatusRepository } from '../repositories/interfaces/entity-status.repository.js';

export function registerEntityStatusTools(
  server: McpServer,
  entityStatusRepo: EntityStatusRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_entity_statuses',
    'Returns the latest known status of people, extracted from IM messages and other signals. Filter by entity name or list all recently updated.',
    {
      entity_name: z.string().optional().describe('Filter by person name (fuzzy match). If omitted, returns all recently updated entities.'),
      since: z.string().optional().describe('Only return statuses updated after this time (ISO 8601). Default: 24h ago'),
      limit: z.number().min(1).max(100).optional().describe('Max results. Default: 20'),
    },
    async (params) => {
      const userId = getUserId();

      if (params.entity_name) {
        const status = await entityStatusRepo.getByName(userId, params.entity_name);
        if (!status) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ statuses: [], total: 0 }),
              },
            ],
          };
        }

        const result = {
          entity_name: status.entityName,
          status_text: status.summary,
          location: status.location ?? null,
          source: status.source ?? null,
          source_message_id: null,
          updated_at: status.timestamp,
        };

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ statuses: [result], total: 1 }),
            },
          ],
        };
      }

      const statuses = await entityStatusRepo.listRecent(userId, {
        since: params.since,
        limit: params.limit,
      });

      const results = statuses.map((s) => ({
        entity_name: s.entityName,
        status_text: s.summary,
        location: s.location ?? null,
        source: s.source ?? null,
        source_message_id: null,
        updated_at: s.timestamp,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ statuses: results, total: results.length }),
          },
        ],
      };
    },
  );
}
