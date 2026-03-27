import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InboxRepository } from '../repositories/interfaces/inbox.repository.js';
import { InboxStatus } from '../types/index.js';

export function registerInboxTools(server: McpServer, repo: InboxRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // capture_inbox
  // -------------------------------------------------------------------------
  server.tool(
    'capture_inbox',
    'Capture a raw item into the GTD inbox for later processing. Quick capture without deciding what it is yet.',
    {
      content: z.string().describe('Raw captured content'),
      source: z.string().optional().describe('Where this came from (e.g. "conversation", "email", "voice")'),
      source_link: z.string().optional().describe('URL or reference to the source'),
    },
    async (params) => {
      const userId = getUserId();
      const item = await repo.capture(userId, {
        content: params.content,
        source: params.source,
        sourceLink: params.source_link,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ inbox_item: item }, null, 2) }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_inbox
  // -------------------------------------------------------------------------
  server.tool(
    'list_inbox',
    'List GTD inbox items. Default: shows unprocessed (captured) items ordered oldest first.',
    {
      status: z.enum(['captured', 'reviewed', 'processed']).optional().describe('Filter by status. Default: captured'),
      limit: z.number().optional().describe('Max results. Default: 50'),
      offset: z.number().optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await repo.list(userId, {
        status: params.status as InboxStatus | undefined,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ inbox_items: result.items, total: result.total }, null, 2),
        }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // process_inbox_item
  // -------------------------------------------------------------------------
  server.tool(
    'process_inbox_item',
    'Mark an inbox item as processed with an outcome type. Records what was decided about the item.',
    {
      id: z.string().describe('Inbox item ID (UUID)'),
      outcome_type: z.enum(['action', 'project', 'someday', 'reference', 'trash']).describe('What to do with this item'),
      outcome_id: z.string().optional().describe('ID of the created action/project, if applicable'),
      notes: z.string().optional().describe('Processing notes'),
    },
    async (params) => {
      const userId = getUserId();
      try {
        const item = await repo.process(userId, params.id, {
          outcomeType: params.outcome_type,
          outcomeId: params.outcome_id,
          notes: params.notes,
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ inbox_item: item }, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
