import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';

export function registerMessageTools(
  server: McpServer,
  messageRepo: MessageRepository,
  getUserId: () => string,
): void {
  server.tool(
    'query_im_messages',
    'Queries IM notifications by sender, app, time range, and keyword. Supports full-text fuzzy search on message content. Each conversation in the results carries a visibility flag: "full" = both sides captured; "inbound_only" = the outbound side is NOT captured, so never claim the user has not replied to such a thread.',
    {
      from: z.string().optional().describe('Start of time range (ISO 8601). Default: 24h ago'),
      to: z.string().optional().describe('End of time range (ISO 8601). Default: now'),
      sender: z.string().optional().describe('Filter by sender name (fuzzy match)'),
      app: z.string().optional().describe('Filter by app: whatsapp, telegram, signal, etc.'),
      keyword: z.string().optional().describe('Full-text fuzzy search on message content'),
      conversation_id: z.string().optional().describe('Filter by specific conversation'),
      is_group: z.boolean().optional().describe('Filter to group or 1:1 messages only'),
      limit: z.number().min(1).max(200).optional().describe('Max results. Default: 50'),
    },
    async (params) => {
      const userId = getUserId();
      const messages = await messageRepo.query(userId, {
        from: params.from,
        to: params.to,
        sender: params.sender,
        app: params.app,
        keyword: params.keyword,
        conversation_id: params.conversation_id,
        is_group: params.is_group,
        limit: params.limit,
      });

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
