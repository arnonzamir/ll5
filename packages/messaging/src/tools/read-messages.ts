import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { TelegramClient } from '../clients/telegram.client.js';
import { getConversationPriority } from '../utils/permission-checker.js';

export function registerReadMessagesTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'read_messages',
    'Read recent messages from a conversation. Only works for conversations in agent or input mode.',
    {
      platform: z.enum(['whatsapp', 'telegram']).describe('Platform'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      limit: z.number().optional().describe('Max messages to return (default: 20)'),
      since: z.string().optional().describe('Only return messages after this ISO 8601 timestamp'),
    },
    async (params) => {
      const userId = getUserId();
      const limit = params.limit ?? 20;

      // Check permission via unified notification rules
      const priority = await getConversationPriority(pool, userId, params.platform, params.conversation_id);
      if (priority === 'ignore') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PERMISSION_DENIED', priority: 'ignore' }) }],
          isError: true,
        };
      }

      // Look up conversation for metadata (account_id, etc.)
      const conversation = await conversationRepo.get(userId, params.platform, params.conversation_id);
      if (!conversation) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CONVERSATION_NOT_FOUND' }) }],
          isError: true,
        };
      }

      const sinceDate = params.since ? new Date(params.since) : undefined;

      if (params.platform === 'whatsapp') {
        return await readWhatsAppMessages(userId, conversation.account_id, params.conversation_id, limit, sinceDate, accountRepo);
      } else {
        return await readTelegramMessages(userId, conversation.account_id, params.conversation_id, limit, sinceDate, accountRepo);
      }
    },
  );
}

async function readWhatsAppMessages(
  userId: string,
  accountId: string,
  conversationId: string,
  limit: number,
  since: Date | undefined,
  accountRepo: AccountRepository,
) {
  const account = await accountRepo.getWhatsApp(userId, accountId);
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
  const rawResult = await client.fetchMessages(conversationId, limit);

  // Defensive: ensure rawMessages is always an array
  const rawMessages = Array.isArray(rawResult) ? rawResult : [];

  const messages = rawMessages
    .map((msg) => {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      const timestamp = msg.messageTimestamp
        ? new Date(msg.messageTimestamp * 1000)
        : new Date();

      return {
        message_id: msg.key?.id ?? '',
        timestamp: timestamp.toISOString(),
        sender_name: msg.pushName ?? (msg.key?.fromMe ? 'Me' : 'Unknown'),
        sender_id: msg.key?.remoteJid ?? '',
        content: text,
        is_from_bot: msg.key?.fromMe ?? false,
        is_group: conversationId.endsWith('@g.us'),
        reply_to_message_id: (msg.contextInfo as { stanzaId?: string })?.stanzaId ?? null,
      };
    })
    .filter((m) => {
      if (!since) return true;
      return new Date(m.timestamp) > since;
    })
    .slice(0, limit);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ messages }, null, 2) }],
  };
}

async function readTelegramMessages(
  userId: string,
  accountId: string,
  conversationId: string,
  limit: number,
  since: Date | undefined,
  accountRepo: AccountRepository,
) {
  const account = await accountRepo.getTelegram(userId, accountId);
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

  const client = new TelegramClient(account.bot_token);
  const updates = await client.getUpdates(undefined, limit);

  const chatIdNum = parseInt(conversationId, 10);
  const messages = updates
    .filter((u) => u.message && u.message.chat.id === chatIdNum)
    .map((u) => {
      const msg = u.message!;
      const timestamp = new Date(msg.date * 1000);
      const senderName = msg.from
        ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ')
        : 'Unknown';

      return {
        message_id: msg.message_id.toString(),
        timestamp: timestamp.toISOString(),
        sender_name: senderName,
        sender_id: msg.from?.id.toString() ?? '',
        content: msg.text ?? '',
        is_from_bot: msg.from?.is_bot ?? false,
        is_group: msg.chat.type === 'group' || msg.chat.type === 'supergroup',
        reply_to_message_id: msg.reply_to_message?.message_id.toString() ?? null,
      };
    })
    .filter((m) => {
      if (!since) return true;
      return new Date(m.timestamp) > since;
    })
    .slice(0, limit);

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ messages }, null, 2) }],
  };
}
