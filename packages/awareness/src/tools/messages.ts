import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { capItems, pageFields, resolveOffset } from '@ll5/shared';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';

const DEFAULT_LIMIT = 50;

export function registerMessageTools(
  server: McpServer,
  messageRepo: MessageRepository,
  getUserId: () => string,
): void {
  server.tool(
    'query_im_messages',
    'Queries IM notifications by sender, app, time range, and keyword. Supports full-text fuzzy search on message content. ' +
      'Each conversation in the results carries a visibility flag: "full" = both sides captured; "inbound_only" = the outbound side is NOT captured, ' +
      'so never claim the user has not replied to such a thread. ' +
      'The result is capped at ~20 KB (cut at message boundaries, newest kept): when more exists it carries truncated:true + next_cursor + hint — ' +
      'narrow with from/to, conversation_id, sender or keyword, lower limit, or pass cursor to continue.',
    {
      from: z.string().optional().describe('Start of time range (ISO 8601). Default: 24h ago'),
      to: z.string().optional().describe('End of time range (ISO 8601). Default: now'),
      sender: z.string().optional().describe('Filter by sender name (fuzzy match)'),
      app: z.string().optional().describe('Filter by app: whatsapp, telegram, signal, etc.'),
      keyword: z.string().optional().describe('Full-text fuzzy search on message content'),
      conversation_id: z.string().optional().describe('Filter by specific conversation'),
      is_group: z.boolean().optional().describe('Filter to group or 1:1 messages only'),
      limit: z.number().min(1).max(200).optional().describe('Max results. Default: 50. The ~20 KB result cap applies on top of this.'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
    },
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
      const limit = params.limit ?? DEFAULT_LIMIT;

      // ISS-019: ask for one row past the page so `hasMore` is exact without a
      // second count query; the probe row is never returned.
      const fetched = await messageRepo.query(userId, {
        from: params.from,
        to: params.to,
        sender: params.sender,
        app: params.app,
        keyword: params.keyword,
        conversation_id: params.conversation_id,
        is_group: params.is_group,
        limit: limit + 1,
        ...(offset > 0 ? { offset } : {}),
      });
      const hasMore = fetched.length > limit;
      const page = capItems(hasMore ? fetched.slice(0, limit) : fetched, {
        offset,
        hasMore,
        hint: 'Narrow with `from`/`to`, `conversation_id`, `sender` or `keyword`.',
      });
      const messages = page.items;

      // Outbound visibility per conversation (DECISION-020 one-sided-thread
      // guard): one terms aggregation over the returned conversations.
      const conversationIds = [...new Set(
        messages
          .map((m) => m.conversation_id)
          .filter((id): id is string => id != null),
      )];
      const visibility = conversationIds.length > 0
        ? await messageRepo.getConversationVisibility(userId, conversationIds)
        : {};
      const conversations = conversationIds.map((id) => ({
        conversation_id: id,
        visibility: visibility[id] ?? 'inbound_only',
      }));

      const envelope: Record<string, unknown> = {
        messages,
        total: messages.length,
        conversations,
      };
      if (conversations.some((c) => c.visibility === 'inbound_only')) {
        envelope.visibility_hint =
          "Some threads are inbound_only: outbound side not captured for this thread — do NOT make 'you haven't replied / unanswered' claims about it.";
      }
      Object.assign(envelope, pageFields(page));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(envelope),
          },
        ],
      };
    },
  );
}
