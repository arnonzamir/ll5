import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { getConversationPriority } from '../utils/permission-checker.js';
import { formatTime, sessionTimezone, capItems, pageFields, resolveOffset } from '@ll5/shared';

const SUPPORTED_PLATFORMS = ['whatsapp', 'telegram'] as const;
type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

function isSupportedPlatform(p: string): p is SupportedPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(p);
}

export function registerReadMessagesTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'read_messages',
    'Read recent messages from a WhatsApp or Telegram conversation (the messaging MCP\'s own accounts). Only works for conversations in agent or input mode. ' +
      'For Slack, SMS, email or any other app, use awareness query_im_messages({ app, conversation_id }) — those are phone-mirrored notifications, not messaging accounts. ' +
      'The result is capped at ~20 KB (cut at message boundaries): when more exists it carries truncated:true + next_cursor + hint — ' +
      'narrow with since, lower limit, or pass cursor to continue.',
    {
      // ISS-021: a free string, validated in the handler, so an unsupported
      // platform ("slack") gets an actionable redirect instead of a bare -32602.
      platform: z.string().describe('Platform: "whatsapp" or "telegram". Other apps (slack, sms, …) are NOT here — use awareness query_im_messages.'),
      conversation_id: z.string().describe('Platform-specific conversation ID'),
      limit: z.number().optional().describe('Max messages to return (default: 20). The ~20 KB result cap applies on top of this.'),
      since: z.string().optional().describe('Only return messages after this ISO 8601 timestamp'),
      cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor). Omit for the first page.'),
    },
    async (params) => {
      const userId = getUserId();
      const limit = params.limit ?? 20;
      const platform = params.platform.trim().toLowerCase();

      if (!isSupportedPlatform(platform)) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'UNSUPPORTED_PLATFORM',
              platform: params.platform,
              supported: SUPPORTED_PLATFORMS,
              hint:
                `"${params.platform}" is not a messaging-MCP account. Slack, SMS, email and other apps are mirrored from the phone as notifications — ` +
                `read them with awareness query_im_messages({ app: "${platform}", conversation_id: "${params.conversation_id}", limit: ${limit} }).`,
            }),
          }],
          isError: true,
        };
      }

      let offset: number;
      try {
        offset = resolveOffset({ cursor: params.cursor });
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
          isError: true,
        };
      }

      // Check permission via unified notification rules
      const priority = await getConversationPriority(pool, userId, platform, params.conversation_id);
      if (priority === 'ignore') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'PERMISSION_DENIED', priority: 'ignore' }) }],
          isError: true,
        };
      }

      // Look up conversation for metadata (account_id, etc.)
      const conversation = await conversationRepo.get(userId, platform, params.conversation_id);
      if (!conversation) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CONVERSATION_NOT_FOUND' }) }],
          isError: true,
        };
      }

      const sinceDate = params.since ? new Date(params.since) : undefined;

      if (platform === 'whatsapp') {
        return await readWhatsAppMessages(userId, conversation.account_id, params.conversation_id, limit, offset, sinceDate, accountRepo);
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
  offset: number,
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
  // ISS-019: Evolution has no offset — fetch through the requested page plus one
  // probe row, then slice client-side. `since` is applied before paging so the
  // cursor walks the filtered list.
  const rawResult = await client.fetchMessages(conversationId, offset + limit + 1);

  // Defensive: ensure rawMessages is always an array
  const rawMessages = Array.isArray(rawResult) ? rawResult : [];

  const filtered = rawMessages
    .map((msg) => {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        '';
      const timestamp = msg.messageTimestamp
        ? new Date(msg.messageTimestamp * 1000)
        : new Date();
      const t = formatTime(timestamp, sessionTimezone());

      return {
        message_id: msg.key?.id ?? '',
        timestamp: t.utc,
        local_time: t.local,
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
    });

  const hasMore = filtered.length > offset + limit;
  const page = capItems(filtered.slice(offset, offset + limit), {
    offset,
    hasMore,
    hint: 'Narrow with `since`.',
    // The envelope is pretty-printed; measure the same way so the cap is real.
    measure: (m) => JSON.stringify(m, null, 2).length,
  });

  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ messages: page.items, tz: sessionTimezone(), ...pageFields(page) }, null, 2) }],
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

  // We intentionally do NOT fetch Telegram history here.
  //
  // The Bot API has no "read past chat history" endpoint. getUpdates() returns
  // the bot's *pending update queue*, not chat history, and reading it with an
  // offset acknowledges (deletes) those updates server-side — which would drop
  // messages for the real consumer (the gateway webhook/poller that ingests
  // incoming Telegram messages). Calling it for history is both incorrect
  // (wrong data) and destructive (steals updates). Bots also only ever see
  // messages sent after they were added, so there is no safe historical read.
  //
  // Telegram messages are ingested via the gateway and persisted; history
  // should be read from our own store, not pulled from the Bot API. Until that
  // path is wired here, return a clear not-supported error rather than silently
  // draining the update queue.
  void accountRepo;
  void account;
  void conversationId;
  void limit;
  void since;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          error: 'TELEGRAM_HISTORY_NOT_SUPPORTED',
          detail:
            'The Telegram Bot API exposes no chat-history endpoint. getUpdates returns the pending update queue and consuming it would drop messages for the gateway ingester. Read Telegram history from the persisted message store instead.',
        }),
      },
    ],
    isError: true,
  };
}
