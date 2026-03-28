import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';

export function registerUpdatePermissionsTool(
  server: McpServer,
  conversationRepo: ConversationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'update_conversation_permissions',
    'Set the permission mode (agent/input/ignore) for a conversation, controlling what the agent can do.',
    {
      platform: z.enum(['whatsapp', 'telegram']).describe('Platform'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      permission: z.enum(['agent', 'input', 'ignore']).describe('New permission level'),
    },
    async (params) => {
      const userId = getUserId();

      try {
        const result = await conversationRepo.updatePermission(
          userId,
          params.platform,
          params.conversation_id,
          params.permission,
        );

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              previous_permission: result.previous_permission,
              new_permission: params.permission,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'CONVERSATION_NOT_FOUND') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CONVERSATION_NOT_FOUND' }) }],
            isError: true,
          };
        }
        throw err;
      }
    },
  );
}
