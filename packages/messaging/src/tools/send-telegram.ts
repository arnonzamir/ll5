import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { TelegramClient } from '../clients/telegram.client.js';

export function registerSendTelegramTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'send_telegram',
    'Send a Telegram message to a chat via Bot API.',
    {
      account_id: z.string().describe('Telegram account UUID'),
      chat_id: z.string().describe('Telegram chat ID (user, group, or channel)'),
      message: z.string().describe('Message text to send'),
      parse_mode: z.enum(['MarkdownV2', 'HTML', 'plain']).optional().describe('Message formatting (default: plain)'),
    },
    async (params) => {
      const userId = getUserId();

      // Get account with decrypted bot token
      const account = await accountRepo.getTelegram(userId, params.account_id);
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
      const conversation = await conversationRepo.get(userId, 'telegram', params.chat_id);
      if (conversation && conversation.permission !== 'agent') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PERMISSION_DENIED', permission: conversation.permission }) }],
          isError: true,
        };
      }

      // Send via Telegram Bot API
      const client = new TelegramClient(account.bot_token);
      const result = await client.sendMessage(params.chat_id, params.message, params.parse_mode);

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SEND_FAILED' }) }],
          isError: true,
        };
      }

      // Log the sent message
      await accountRepo.logSentMessage(
        userId,
        params.account_id,
        'telegram',
        params.chat_id,
        result.message_id?.toString(),
      );

      // Update last_message_at
      if (conversation) {
        await conversationRepo.touchLastMessage(userId, 'telegram', params.chat_id, new Date());
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
