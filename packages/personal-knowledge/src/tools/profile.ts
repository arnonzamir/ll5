import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProfileRepository } from '../repositories/interfaces/profile.repository.js';

export function registerProfileTools(
  server: McpServer,
  profileRepo: ProfileRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_profile',
    'Retrieve the user profile including name, timezone, location, bio, languages.',
    {},
    async () => {
      const userId = getUserId();
      const profile = await profileRepo.get(userId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ profile: profile ?? null }),
          },
        ],
      };
    },
  );

  server.tool(
    'update_profile',
    'Update fields on the user profile. Only provided fields are changed.',
    {
      name: z.string().optional().describe('Display name'),
      timezone: z.string().optional().describe('IANA timezone (e.g. Asia/Jerusalem)'),
      location: z.string().optional().describe('Free-text current location'),
      bio: z.string().optional().describe('Short biography'),
      birth_date: z.string().optional().describe('ISO 8601 date (YYYY-MM-DD)'),
      languages: z.array(z.string()).optional().describe('Spoken languages'),
    },
    async (params) => {
      const userId = getUserId();
      const profile = await profileRepo.upsert(userId, {
        name: params.name,
        timezone: params.timezone,
        location: params.location,
        bio: params.bio,
        birthDate: params.birth_date,
        languages: params.languages,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ profile }),
          },
        ],
      };
    },
  );
}
