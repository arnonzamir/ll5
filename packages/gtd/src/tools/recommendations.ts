import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerRecommendationTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // recommend_actions
  // -------------------------------------------------------------------------
  server.tool(
    'recommend_actions',
    'Get smart action recommendations based on current energy, available time, and context. Returns actions grouped by depth (quick/medium/deep) and ranked by relevance.',
    {
      energy: z.enum(['low', 'medium', 'high']).optional().describe('Current energy level'),
      time_available: z.number().optional().describe('Available minutes'),
      context_tags: z.array(z.string()).optional().describe('Current context tags (e.g. ["@home", "@computer"])'),
      limit: z.number().optional().describe('Max actions per group. Default: 5'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await repo.recommendActions(userId, {
        energy: params.energy,
        timeAvailable: params.time_available,
        contextTags: params.context_tags,
        limit: params.limit,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            recommendations: result,
            criteria_used: {
              energy: params.energy ?? null,
              time_available: params.time_available ?? null,
              context_tags: params.context_tags ?? [],
            },
          }, null, 2),
        }],
      };
    },
  );
}
