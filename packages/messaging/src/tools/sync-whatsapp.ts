import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';

export function registerSyncWhatsAppTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'sync_whatsapp_conversations',
    'Refresh the conversation list from WhatsApp via Evolution API. Discovers new conversations and updates names. Existing permission settings are preserved.',
    {
      account_id: z.string().describe('WhatsApp account UUID to sync'),
    },
    async (params) => {
      const userId = getUserId();

      const account = await accountRepo.getWhatsApp(userId, params.account_id);
      if (!account) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_NOT_FOUND' }) }],
          isError: true,
        };
      }

      if (account.status !== 'connected') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'ACCOUNT_DISCONNECTED', status: account.status }) }],
          isError: true,
        };
      }

      const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);
      const chats = await client.findChats();

      let newCount = 0;
      let updatedCount = 0;

      for (const chat of chats) {
        const result = await conversationRepo.upsert(userId, {
          account_id: params.account_id,
          platform: 'whatsapp',
          conversation_id: chat.id,
          name: chat.name,
          is_group: chat.isGroup,
        });

        if (result.created) {
          newCount++;
        } else {
          updatedCount++;
        }

        // Update last_message_at if available
        if (chat.lastMessageTimestamp) {
          await conversationRepo.touchLastMessage(
            userId,
            'whatsapp',
            chat.id,
            new Date(chat.lastMessageTimestamp * 1000),
          );
        }
      }

      // Get total count after sync
      const allConversations = await conversationRepo.list(userId, {
        platform: 'whatsapp',
        account_id: params.account_id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            total_conversations: allConversations.length,
            new_conversations: newCount,
            updated_conversations: updatedCount,
          }, null, 2),
        }],
      };
    },
  );
}
