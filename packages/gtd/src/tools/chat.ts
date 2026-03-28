import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';

interface GatewayConfig {
  gatewayUrl: string;
  authSecret: string;
}

/**
 * Make an authenticated request to the gateway.
 * Generates a service token for the given user.
 */
async function gatewayFetch(
  config: GatewayConfig,
  userId: string,
  path: string,
  options: { method?: string; body?: unknown; params?: Record<string, string> } = {},
): Promise<unknown> {
  const crypto = await import('node:crypto');

  // Generate a service token for the user (same format as @ll5/shared generateToken)
  const payload = {
    uid: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 300, // 5 minute TTL for service calls
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.authSecret)
    .update(payloadB64).digest('hex').slice(0, 32);
  const token = `ll5.${payloadB64}.${signature}`;

  let url = `${config.gatewayUrl}${path}`;
  if (options.params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(options.params)) {
      if (value !== undefined && value !== '') {
        searchParams.append(key, value);
      }
    }
    const qs = searchParams.toString();
    if (qs) url += `?${qs}`;
  }

  const fetchOptions: RequestInit = {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };

  if (options.body) {
    fetchOptions.body = JSON.stringify(options.body);
  }

  const response = await fetch(url, fetchOptions);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gateway request failed (${response.status}): ${errorText}`);
  }

  return response.json();
}

export function registerChatTools(
  server: McpServer,
  config: GatewayConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // check_messages — check for pending inbound messages from external channels
  // ---------------------------------------------------------------------------
  server.tool(
    'check_messages',
    'Check for pending inbound messages from external channels (web, Telegram, WhatsApp). Returns unread messages oldest-first. Each message has an id — pass it as reply_to_id when calling send_message to mark it as delivered.',
    {
      channel: z.enum(['web', 'telegram', 'whatsapp', 'cli', 'android']).optional()
        .describe('Filter by channel. If omitted, returns messages from all channels.'),
    },
    async (params) => {
      const userId = getUserId();
      try {
        const queryParams: Record<string, string> = {};
        if (params.channel) queryParams.channel = params.channel;

        const result = await gatewayFetch(
          config, userId, '/chat/pending', { params: queryParams },
        ) as { messages: Array<{ id: string }> };

        // Mark all as processing so they won't appear in next check
        for (const msg of result.messages ?? []) {
          await gatewayFetch(config, userId, `/chat/messages/${msg.id}`, {
            method: 'PATCH',
            body: { status: 'processing' },
          }).catch(() => {});
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('check_messages failed', { error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // send_message — send a response to a specific channel/conversation
  // ---------------------------------------------------------------------------
  server.tool(
    'send_message',
    'Send a message to an external channel (web, Telegram, WhatsApp). Use this to respond to inbound messages or initiate outbound messages.',
    {
      channel: z.enum(['web', 'telegram', 'whatsapp', 'cli', 'android'])
        .describe('Target channel for the message'),
      content: z.string().describe('Message content to send'),
      conversation_id: z.string().optional()
        .describe('Conversation ID to reply in. If omitted, creates a new conversation.'),
      reply_to_id: z.string().optional()
        .describe('ID of the inbound message being replied to. Marks it as delivered.'),
      metadata: z.record(z.unknown()).optional()
        .describe('Optional metadata (e.g. telegram_chat_id, whatsapp_phone)'),
    },
    async (params) => {
      const userId = getUserId();
      try {
        const result = await gatewayFetch(
          config, userId, '/chat/messages', {
            method: 'POST',
            body: {
              channel: params.channel,
              content: params.content,
              conversation_id: params.conversation_id,
              metadata: params.metadata,
              direction: 'outbound',
              role: 'assistant',
            },
          },
        );

        // Mark the original inbound message as delivered
        if (params.reply_to_id) {
          await gatewayFetch(config, userId, `/chat/messages/${params.reply_to_id}`, {
            method: 'PATCH',
            body: { status: 'delivered' },
          }).catch(() => {});
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('send_message failed', { error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // list_conversations — list active chat conversations across channels
  // ---------------------------------------------------------------------------
  server.tool(
    'list_conversations',
    'List active chat conversations across external channels. Shows last message and unread count per conversation.',
    {
      channel: z.enum(['web', 'telegram', 'whatsapp', 'cli', 'android']).optional()
        .describe('Filter by channel'),
      limit: z.number().optional().describe('Max conversations to return. Default: 20'),
    },
    async (params) => {
      const userId = getUserId();
      try {
        const queryParams: Record<string, string> = {};
        if (params.channel) queryParams.channel = params.channel;
        if (params.limit) queryParams.limit = String(params.limit);

        const result = await gatewayFetch(
          config, userId, '/chat/conversations', { params: queryParams },
        );

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('list_conversations failed', { error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );
}
