import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { logger } from '../utils/logger.js';

/**
 * Extract a phone number from a WhatsApp JID.
 * E.g. "972501234567@s.whatsapp.net" → "+972501234567"
 *      "972501234567-123456@g.us" → null (group)
 */
function phoneFromJid(jid: string): string | null {
  if (jid.endsWith('@g.us')) return null;
  const num = jid.split('@')[0];
  if (!num || !/^\d+$/.test(num)) return null;
  return `+${num}`;
}

export function registerSyncWhatsAppTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'sync_whatsapp_conversations',
    'Refresh the conversation list from WhatsApp via Evolution API. Discovers new conversations, updates names, and syncs contacts to the contact registry. Existing permission settings are preserved.',
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
      const { chats, contacts: rawContacts } = await client.findChats();

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

      // ------------------------------------------------------------------
      // Bulk upsert contacts from the Evolution contacts API response
      // ------------------------------------------------------------------
      let contactCount = 0;
      if (rawContacts.length > 0) {
        const contactInputs = rawContacts.map((c) => ({
          platform: 'whatsapp' as const,
          platform_id: c.remoteJid,
          display_name: c.pushName ?? undefined,
          phone_number: phoneFromJid(c.remoteJid) ?? undefined,
          is_group: c.remoteJid.endsWith('@g.us'),
        }));

        contactCount = await contactRepo.bulkUpsert(userId, contactInputs);
        logger.info('[syncWhatsAppConversations] Contacts synced', { contactCount });
      }

      // Also upsert contacts from chats (some contacts may only appear in chats, not in findContacts)
      const chatContactInputs = chats.map((chat) => ({
        platform: 'whatsapp' as const,
        platform_id: chat.id,
        display_name: chat.name,
        phone_number: phoneFromJid(chat.id) ?? undefined,
        is_group: chat.isGroup,
      }));

      if (chatContactInputs.length > 0) {
        const chatContactCount = await contactRepo.bulkUpsert(userId, chatContactInputs);
        logger.info('[syncWhatsAppConversations] Chat-based contacts synced', { chatContactCount });
        contactCount += chatContactCount;
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
            contacts_synced: contactCount,
          }, null, 2),
        }],
      };
    },
  );
}
