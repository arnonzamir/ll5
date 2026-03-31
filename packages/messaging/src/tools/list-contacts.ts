import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';

export function registerListContactsTool(
  server: McpServer,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_contacts',
    'List messaging contacts with optional filters. Contacts are auto-discovered during WhatsApp sync and can be linked to People in the knowledge base.',
    {
      platform: z.enum(['whatsapp', 'telegram', 'sms']).optional().describe('Filter by platform'),
      query: z.string().optional().describe('Search by name or phone number (partial match)'),
      linked_only: z.boolean().optional().describe('If true, only show contacts linked to a Person; if false, only unlinked'),
      limit: z.number().optional().describe('Max results (default: 100)'),
    },
    async (params) => {
      const userId = getUserId();

      const contacts = await contactRepo.list(userId, {
        platform: params.platform,
        query: params.query,
        hasPersonLink: params.linked_only,
        limit: params.limit,
      });

      const result = contacts.map((c) => ({
        id: c.id,
        platform: c.platform,
        platform_id: c.platform_id,
        display_name: c.display_name,
        phone_number: c.phone_number,
        is_group: c.is_group,
        person_id: c.person_id,
        last_seen_at: c.last_seen_at?.toISOString() ?? null,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ contacts: result, count: result.length }, null, 2) }],
      };
    },
  );
}
