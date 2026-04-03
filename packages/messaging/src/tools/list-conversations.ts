import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';

export function registerListConversationsTool(
  server: McpServer,
  conversationRepo: ConversationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_conversations',
    'List monitored conversations across platforms with their permission levels and last activity.',
    {
      platform: z.enum(['whatsapp', 'telegram']).optional().describe('Filter by platform'),
      permission: z.enum(['agent', 'input', 'ignore']).optional().describe('Filter by permission level'),
      account_id: z.string().optional().describe('Filter by specific account'),
      is_group: z.boolean().optional().describe('Filter to groups or 1:1 conversations only'),
      query: z.string().optional().describe('Search by conversation name or ID (partial match)'),
      limit: z.number().optional().describe('Max results (default: 50)'),
      offset: z.number().optional().describe('Offset for pagination (default: 0)'),
    },
    async (params) => {
      const userId = getUserId();

      const { conversations, total } = await conversationRepo.list(userId, {
        platform: params.platform,
        permission: params.permission,
        account_id: params.account_id,
        is_group: params.is_group,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });

      const result = conversations.map((c) => ({
        conversation_id: c.conversation_id,
        account_id: c.account_id,
        platform: c.platform,
        name: c.name,
        is_group: c.is_group,
        is_archived: c.is_archived,
        permission: c.permission,
        last_message_at: c.last_message_at?.toISOString() ?? null,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ conversations: result, total }, null, 2) }],
      };
    },
  );
}
