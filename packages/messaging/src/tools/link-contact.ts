import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';

export function registerLinkContactTool(
  server: McpServer,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'link_contact_to_person',
    'Link a messaging contact to a Person in the personal-knowledge base. This enables cross-referencing between messaging contacts and curated People records.',
    {
      contact_id: z.string().describe('UUID of the messaging contact'),
      person_id: z.string().describe('ID of the Person in the personal-knowledge MCP'),
    },
    async (params) => {
      const userId = getUserId();

      try {
        await contactRepo.linkPerson(userId, params.contact_id, params.person_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'CONTACT_NOT_FOUND') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CONTACT_NOT_FOUND' }) }],
            isError: true,
          };
        }
        throw err;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    },
  );
}

export function registerUnlinkContactTool(
  server: McpServer,
  contactRepo: ContactRepository,
  getUserId: () => string,
): void {
  server.tool(
    'unlink_contact_from_person',
    'Remove the link between a messaging contact and a Person in the personal-knowledge base.',
    {
      contact_id: z.string().describe('UUID of the messaging contact'),
    },
    async (params) => {
      const userId = getUserId();

      try {
        await contactRepo.unlinkPerson(userId, params.contact_id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'CONTACT_NOT_FOUND') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'CONTACT_NOT_FOUND' }) }],
            isError: true,
          };
        }
        throw err;
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true }) }],
      };
    },
  );
}
