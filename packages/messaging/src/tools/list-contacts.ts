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
      named_only: z.boolean().optional().describe('If true, only show contacts with a display name (exclude phone-number-only entries)'),
      is_group: z.boolean().optional().describe('Filter by group status (true = groups only, false = individuals only)'),
      limit: z.number().optional().describe('Max results (default: 100)'),
      offset: z.number().optional().describe('Offset for pagination (default: 0)'),
    },
    async (params) => {
      const userId = getUserId();

      const { contacts, total } = await contactRepo.list(userId, {
        platform: params.platform,
        query: params.query,
        hasPersonLink: params.linked_only,
        hasName: params.named_only,
        is_group: params.is_group,
        limit: params.limit,
        offset: params.offset,
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
        content: [{ type: 'text' as const, text: JSON.stringify({ contacts: result, total, count: result.length }, null, 2) }],
      };
    },
  );
}
