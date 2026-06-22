import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { TelegramClient } from '../clients/telegram.client.js';
import { getConversationPriority } from '../utils/permission-checker.js';
import { checkLl5Prefix } from '../utils/ll5-prefix.js';
import { logAudit } from '@ll5/shared';

export function registerSendTelegramTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'send_telegram',
    'Send a Telegram message to a chat via Bot API. ' +
      'FIRST-CONTACT GATE: the very first message to a chat the agent has never ' +
      'messaged before is blocked unless confirmed:true. On a block, surface the ' +
      'drafted message to the user, get their explicit approval, then call again ' +
      'with confirmed:true. Established threads (any prior outbound) send normally.',
    {
      account_id: z.string().describe('Telegram account UUID'),
      chat_id: z.string().describe('Telegram chat ID (user, group, or channel)'),
      message: z.string().describe('Message text to send'),
      parse_mode: z.enum(['MarkdownV2', 'HTML', 'plain']).optional().describe('Message formatting (default: plain)'),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          'Set true ONLY after the user explicitly approved a first message to a ' +
            'new chat. Ignored for established threads. Defaults to false.',
        ),
    },
    async (params) => {
      const userId = getUserId();

      // Deterministic [LL5] identity gate — a contact-bound message MUST start with
      // the [LL5] prefix. Reject + correct BEFORE any send (non-agentic, non-bypassable).
      const prefix = checkLl5Prefix(params.message);
      if (!prefix.ok) {
        logAudit({
          user_id: userId,
          source: 'messaging',
          action: 'send_rejected_no_prefix',
          entity_type: 'telegram_message',
          entity_id: params.chat_id,
          summary: `Rejected Telegram message to chat ${params.chat_id} — missing [LL5] prefix`,
          metadata: { account_id: params.account_id, chat_id: params.chat_id, reason: 'missing_ll5_prefix' },
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ sent: false, rejected: 'missing_ll5_prefix', correction: prefix.correction }, null, 2),
          }],
        };
      }

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

      // Check conversation permission via unified notification rules
      const priority = await getConversationPriority(pool, userId, 'telegram', params.chat_id);
      if (priority !== 'agent') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PERMISSION_DENIED', priority: priority ?? 'no-rule', message: 'Only conversations with "agent" priority can receive messages' }) }],
          isError: true,
        };
      }
      const conversation = await conversationRepo.get(userId, 'telegram', params.chat_id);

      // First-contact send-gate: a first message to a chat the agent has never
      // messaged before must be explicitly approved by the user. The agent can
      // only set confirmed:true after surfacing the draft and getting a yes.
      // TODO(follow-up): make this non-bypassable — gate on a real user-approval
      // record (user approves in-app) rather than trusting the agent to set
      // confirmed:true. Today this is pragmatic enforcement at the tool layer.
      const priorSends = await accountRepo.countSentToRecipient(userId, 'telegram', params.chat_id);
      if (priorSends === 0 && params.confirmed !== true) {
        logAudit({
          user_id: userId,
          source: 'messaging',
          action: 'send_blocked',
          entity_type: 'telegram_message',
          entity_id: params.chat_id,
          summary: `Blocked first-contact Telegram message to chat ${params.chat_id} (needs approval)`,
          metadata: { account_id: params.account_id, chat_id: params.chat_id, reason: 'first_contact_needs_approval' },
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              sent: false,
              blocked: 'first_contact_needs_approval',
              message: `First message to ${params.chat_id} — get the user's explicit approval, then resend with confirmed:true.`,
            }, null, 2),
          }],
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

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'send',
        entity_type: 'telegram_message',
        entity_id: result.message_id?.toString() ?? 'unknown',
        summary: `Sent Telegram message to chat ${params.chat_id}`,
        metadata: { account_id: params.account_id, chat_id: params.chat_id },
      });

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
