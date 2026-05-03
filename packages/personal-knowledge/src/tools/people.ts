import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PersonRepository } from '../repositories/interfaces/person.repository.js';
import { logAudit } from '@ll5/shared';

export function registerPeopleTools(
  server: McpServer,
  personRepo: PersonRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_people',
    'List people in the user network with optional filters.',
    {
      relationship: z.string().optional().describe('Filter by relationship (e.g. friend, family, colleague)'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
      query: z.string().optional().describe('Free-text search across name, aliases, notes'),
      status: z.enum(['full', 'contact-only']).optional().describe('Filter by status. full = KB persons, contact-only = auto-created from messaging contacts'),
      limit: z.number().min(1).max(5000).optional().describe('Max results. Default: 50. Cap raised to 5000 because the dashboard /settings/contacts page needs the full set to categorize contacts.'),
      offset: z.number().min(0).optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await personRepo.list(userId, {
        relationship: params.relationship,
        tags: params.tags,
        query: params.query,
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ people: result.items, total: result.total }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_person',
    'Retrieve a single person by ID.',
    {
      id: z.string().describe('Person ID'),
    },
    async (params) => {
      const userId = getUserId();
      const person = await personRepo.get(userId, params.id);
      if (!person) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Person not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ person }) }],
      };
    },
  );

  server.tool(
    'upsert_person',
    'Create or update a person record.',
    {
      id: z.string().optional().describe('Person ID to update. Omit to create new.'),
      name: z.string().describe('Primary display name'),
      aliases: z.array(z.string()).optional().describe('Alternative names (Hebrew+English, nicknames)'),
      relationship: z.string().optional().describe('Relationship to user (free-text)'),
      contact_info: z.record(z.string(), z.string()).optional().describe('Contact info key-value pairs'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      notes: z.string().optional().describe('Free-text notes about this person'),
      status: z.enum(['full', 'contact-only']).optional().describe('Person status. full = KB person (default), contact-only = lightweight record from messaging contact'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await personRepo.upsert(userId, {
        id: params.id,
        name: params.name,
        aliases: params.aliases,
        relationship: params.relationship,
        contactInfo: params.contact_info,
        tags: params.tags,
        notes: params.notes,
        status: params.status,
      });

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: result.created ? 'create' : 'update',
        entity_type: 'person',
        entity_id: result.person.id,
        summary: `${result.created ? 'Created' : 'Updated'} person: ${params.name}`,
        metadata: { relationship: params.relationship },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ person: result.person, created: result.created }),
          },
        ],
      };
    },
  );

  server.tool(
    'delete_person',
    'Delete a person by ID.',
    {
      id: z.string().describe('Person ID'),
    },
    async (params) => {
      const userId = getUserId();
      const deleted = await personRepo.delete(userId, params.id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Person not found' }) }],
          isError: true,
        };
      }

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: 'delete',
        entity_type: 'person',
        entity_id: params.id,
        summary: `Deleted person ${params.id}`,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }) }],
      };
    },
  );
}
