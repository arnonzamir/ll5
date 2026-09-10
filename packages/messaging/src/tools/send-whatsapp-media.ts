import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import { EvolutionClient } from '../clients/evolution.client.js';
import { runWhatsAppSendGates } from '../utils/send-gates.js';
import { logAudit } from '@ll5/shared';

export function registerSendWhatsAppMediaTool(
  server: McpServer,
  accountRepo: AccountRepository,
  conversationRepo: ConversationRepository,
  pool: Pool,
  getUserId: () => string,
): void {
  server.tool(
    'send_whatsapp_media',
    'Send a file (image, video, audio or document) to a WhatsApp contact or group by URL. ' +
      'The URL must be publicly reachable — Evolution fetches it directly; for a stored LL5 ' +
      'file, resolve it with the awareness get_media tool first, and use a public URL ' +
      '(/chat/upload?public=1) since /uploads is auth-gated. The caption carries the [LL5] ' +
      'prefix and is REQUIRED — a media message with no caption cannot identify itself. ' +
      'Same first-contact gate as send_whatsapp: the very first message to a new recipient ' +
      'is blocked unless confirmed:true.',
    {
      account_id: z.string().describe('WhatsApp account UUID'),
      to: z.string().describe('Recipient phone number (with country code) or group JID'),
      media_url: z.string().describe('Publicly reachable URL of the file to send'),
      mediatype: z
        .enum(['image', 'video', 'audio', 'document'])
        .describe('How WhatsApp renders it. Use "document" for anything that is not playable media.'),
      caption: z
        .string()
        .describe('Message text sent with the file. Must start with the [LL5] prefix.'),
      filename: z
        .string()
        .optional()
        .describe('Filename shown to the recipient. Recommended for mediatype "document".'),
      mimetype: z.string().optional().describe('MIME type, when the URL does not make it obvious'),
      confirmed: z
        .boolean()
        .optional()
        .describe(
          'Set true ONLY after the user explicitly approved a first message to a ' +
            'new contact. Ignored for established threads. Defaults to false.',
        ),
    },
    async (params) => {
      const userId = getUserId();

      const gate = await runWhatsAppSendGates(
        {
          userId,
          accountId: params.account_id,
          to: params.to,
          identityText: params.caption,
          confirmed: params.confirmed,
        },
        accountRepo,
        conversationRepo,
        pool,
      );

      if (!gate.ok) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(gate.payload, null, 2) }],
          ...(gate.isError ? { isError: true } : {}),
        };
      }

      const client = new EvolutionClient(
        gate.account.api_url,
        gate.account.instance_name,
        gate.account.api_key,
      );
      const result = await client.sendMedia(params.to, params.media_url, params.mediatype, {
        caption: params.caption,
        fileName: params.filename,
        mimetype: params.mimetype,
      });

      if (!result.success) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'SEND_FAILED' }) }],
          isError: true,
        };
      }

      await accountRepo.logSentMessage(
        userId,
        params.account_id,
        'whatsapp',
        params.to,
        result.message_id ?? undefined,
      );

      if (gate.hasConversation) {
        await conversationRepo.touchLastMessage(userId, 'whatsapp', gate.conversationId, new Date());
      }

      logAudit({
        user_id: userId,
        source: 'messaging',
        action: 'send_media',
        entity_type: 'whatsapp_message',
        entity_id: result.message_id ?? 'unknown',
        summary: `Sent WhatsApp ${params.mediatype} to ${params.to}`,
        metadata: {
          account_id: params.account_id,
          to: params.to,
          mediatype: params.mediatype,
          filename: params.filename ?? null,
        },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message_id: result.message_id,
            mediatype: params.mediatype,
            timestamp: new Date().toISOString(),
          }, null, 2),
        }],
      };
    },
  );
}
