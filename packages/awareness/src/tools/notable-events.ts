import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';

export function registerNotableEventTools(
  server: McpServer,
  notableEventRepo: NotableEventRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_notable_events',
    'Returns unacknowledged notable events since a given timestamp. Used by proactive checks to determine if the agent should alert the user.',
    {
      since: z.string().optional().describe('Only return events created after this time (ISO 8601). Default: 1h ago'),
      event_type: z.string().optional().describe('Filter by type: place_arrival, urgent_im, calendar_soon, entity_status_change'),
      min_severity: z.string().optional().describe('Minimum severity: low, medium, high. Default: low'),
    },
    async (params) => {
      const userId = getUserId();
      const events = await notableEventRepo.queryUnacknowledged(userId, {
        since: params.since,
        event_type: params.event_type,
        min_severity: params.min_severity,
      });

      const results = events.map((e) => ({
        id: e.id,
        event_type: e.type,
        summary: e.summary,
        severity: (e.details as Record<string, unknown>)?.severity ?? 'low',
        payload: e.details ?? {},
        created_at: e.timestamp,
        acknowledged_at: e.acknowledged ? e.timestamp : null,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ events: results, total: results.length }),
          },
        ],
      };
    },
  );

  server.tool(
    'acknowledge_events',
    'Marks notable events as acknowledged so they are no longer surfaced by get_notable_events or get_situation.',
    {
      event_ids: z.array(z.string()).describe('Array of notable event document IDs to acknowledge'),
    },
    async (params) => {
      const userId = getUserId();
      const count = await notableEventRepo.acknowledge(userId, params.event_ids);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ acknowledged_count: count }),
          },
        ],
      };
    },
  );
}
