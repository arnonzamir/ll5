import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProfileRepository } from '../repositories/interfaces/profile.repository.js';
import { logAudit } from '@ll5/shared';

export function registerProfileTools(
  server: McpServer,
  profileRepo: ProfileRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_profile',
    'Retrieve the user profile including name, timezone, location, bio, languages, primary_language.',
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
      languages: z.array(z.string()).optional().describe('Languages the user speaks (informational; not the response-language preference)'),
      primary_language: z.string().optional().describe('Preferred language for agent responses (e.g. "English", "Hebrew"). When set, agent uses this regardless of the language of the user\'s current message (except verbatim quotes). Empty/undefined falls back to the default-English-with-Hebrew-match heuristic in CLAUDE.md.'),
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
        primaryLanguage: params.primary_language,
      });

      logAudit({
        user_id: userId,
        source: 'knowledge',
        action: 'update',
        entity_type: 'profile',
        entity_id: userId,
        summary: `Updated profile`,
        metadata: { fields: Object.keys(params).filter((k) => params[k as keyof typeof params] !== undefined) },
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
