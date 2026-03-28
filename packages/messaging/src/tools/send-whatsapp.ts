import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';

export function registerSendWhatsAppTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'send_whatsapp',
    'Send a WhatsApp message to a contact or group via Evolution API.',
    {
      account_id: z.string().describe('WhatsApp account UUID'),
      to: z.string().describe('Recipient phone number (with country code) or group JID'),
      message: z.string().describe('Message text to send'),
    },
    async (params) => {
      const userId = getUserId();

      // Get account with decrypted API key
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

      // Check conversation permission
      const conversationId = params.to.includes('@') ? params.to : `${params.to}@s.whatsapp.net`;
      const conversation = await conversationRepo.get(userId, 'whatsapp', conversationId);
      if (conversation && conversation.permission !== 'agent') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PERMISSION_DENIED', permission: conversation.permission }) }],
          isError: true,
        };
      }

      // Send via Evolution API
      const client = new EvolutionClient(account.api_url, account.instance_name, account.api_key);
      const result = await client.sendText(params.to, params.message);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SEND_FAILED' }) }],
          isError: true,
        };
      }

      // Log the sent message
      await accountRepo.logSentMessage(userId, params.account_id, 'whatsapp', params.to, result.message_id ?? undefined);

      // Update last_message_at
      if (conversation) {
        await conversationRepo.touchLastMessage(userId, 'whatsapp', conversationId, new Date());
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message_id: result.message_id,
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    },
  );
}
