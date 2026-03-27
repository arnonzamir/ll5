import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerHealthTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // get_gtd_health
  // -------------------------------------------------------------------------
  server.tool(
    'get_gtd_health',
    'Get a summary of GTD system health metrics: inbox count, stale projects, overdue actions, waiting items, and review status.',
    {},
    async () => {
      const userId = getUserId();
      const health = await repo.getHealth(userId);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ health }, null, 2),
        }],
      };
    },
  );
}
