import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capItems, pageFields, resolveOffset } from '@ll5/shared';
import type { CallRepository } from '../repositories/interfaces/call.repository.js';

const DEFAULT_LIMIT = 50;
export const CALL_LIMIT_MAX = 100;

export const queryCallsSchema = {
  since: z.string().optional().describe('Start of time range (ISO 8601, on started_at). Default: 7 days ago'),
  until: z.string().optional().describe('End of time range (ISO 8601). Default: now'),
  direction: z.enum(['incoming', 'outgoing', 'missed']).optional().describe('Filter by direction'),
  number: z.string().optional().describe('Phone number (as sent or by trailing digits)'),
  contact: z.string().optional().describe('Contact name (fuzzy)'),
  limit: z.number().int().min(1).max(CALL_LIMIT_MAX).optional().describe(`Max results. Default: ${DEFAULT_LIMIT}, max ${CALL_LIMIT_MAX}. The ~20 KB result cap applies on top of this.`),
  cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
};

export function registerCallTools(
  server: McpServer,
  repo: CallRepository,
  getUserId: () => string,
): void {
  server.tool(
    'query_calls',
    'Queries phone calls (incoming / outgoing / missed) reported by the phone: who, when, how long, and whether the number resolved to a known contact. ' +
      'One row per call, newest first. A missed call is a fact about the phone, not a request to call back. ' +
      'The result is capped at ~20 KB (cut at item boundaries): when more exists it carries truncated:true + next_cursor + hint.',
    queryCallsSchema,
    async (params) => {
      const userId = getUserId();
      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, CALL_LIMIT_MAX);

      const fetched = await repo.query(userId, {
        since: params.since,
        until: params.until,
        direction: params.direction,
        number: params.number,
        contact: params.contact,
        limit: limit + 1,
        ...(offset > 0 ? { offset } : {}),
      });
      const hasMore = fetched.length > limit;
      const page = capItems(hasMore ? fetched.slice(0, limit) : fetched, {
        offset,
        hasMore,
        hint: 'Narrow with `since`/`until`, `direction`, `number` or `contact`.',
      });
      const envelope: Record<string, unknown> = {
        calls: page.items,
        total: page.items.length,
        ...pageFields(page),
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
    },
  );
}
