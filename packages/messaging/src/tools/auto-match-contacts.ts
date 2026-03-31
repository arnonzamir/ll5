import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';
import { logger } from '../utils/logger.js';

interface SuggestedMatch {
  contact_id: string;
  contact_name: string;
  contact_platform: string;
  contact_platform_id: string;
}

export function registerAutoMatchContactsTool(
  server: McpServer,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'auto_match_contacts',
    'List all unlinked contacts that have a display name, so Claude can match them to People in the personal-knowledge MCP. Returns contacts grouped by name for manual review and linking.',
    {
      platform: z.enum(['whatsapp', 'telegram', 'sms']).optional().describe('Optionally filter to a single platform'),
      limit: z.number().optional().describe('Max contacts to return (default: 200)'),
    },
    async (params) => {
      const userId = getUserId();

      // Fetch all unlinked contacts that have a display name
      const contacts = await contactRepo.list(userId, {
        platform: params.platform,
        hasPersonLink: false,
        limit: params.limit ?? 200,
      });

      // Filter to those with a display name (skip groups and unnamed contacts)
      const candidates = contacts.filter(
        (c) => c.display_name && !c.is_group,
      );

      logger.info('[autoMatchContacts] Found unlinked contact candidates', {
        total_unlinked: contacts.length,
        with_name: candidates.length,
      });

      const suggestions: SuggestedMatch[] = candidates.map((c) => ({
        contact_id: c.id,
        contact_name: c.display_name!,
        contact_platform: c.platform,
        contact_platform_id: c.platform_id,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            unlinked_contacts: suggestions,
            count: suggestions.length,
            instructions: 'Search the personal-knowledge MCP for People matching these contact names. Then use link_contact_to_person for confirmed matches.',
          }, null, 2),
        }],
      };
    },
  );
}
