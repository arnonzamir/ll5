import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';

export function registerResolveContactTool(
  server: McpServer,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'resolve_contact',
    'Look up a contact by platform and platform ID (e.g. WhatsApp JID, Telegram chat_id). Returns the contact record including any linked person_id.',
    {
      platform: z.enum(['whatsapp', 'telegram', 'sms']).describe('Platform to search'),
      platform_id: z.string().describe('Platform-specific ID (JID for WhatsApp, chat_id for Telegram, phone for SMS)'),
    },
    async (params) => {
      const userId = getUserId();

      const contact = await contactRepo.resolve(userId, params.platform, params.platform_id);

      if (!contact) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ contact: null }) }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            contact: {
              id: contact.id,
              platform: contact.platform,
              platform_id: contact.platform_id,
              display_name: contact.display_name,
              phone_number: contact.phone_number,
              is_group: contact.is_group,
              person_id: contact.person_id,
              last_seen_at: contact.last_seen_at?.toISOString() ?? null,
            },
          }, null, 2),
        }],
      };
    },
  );
}
