import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';

export function registerHorizonTools(server: McpServer, repo: HorizonRepository, getUserId: () => string): void {

  // -------------------------------------------------------------------------
  // upsert_horizon
  // -------------------------------------------------------------------------
  server.tool(
    'upsert_horizon',
    'Create or update a higher-level GTD horizon item (h=2 areas, h=3 goals, h=4 vision, h=5 purpose). Use create_action for h=0 and create_project for h=1.',
    {
      id: z.string().optional().describe('Horizon item ID to update. Omit to create new.'),
      horizon: z.number().min(2).max(5).describe('Horizon level: 2 (areas), 3 (goals), 4 (vision), 5 (purpose)'),
      title: z.string().describe('Title'),
      description: z.string().optional().describe('Detailed description'),
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('Status. Default: active'),
    },
    async (params) => {
      const userId = getUserId();

      if (params.horizon < 2) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: 'Use create_action for h=0 and create_project for h=1. This tool handles h=2 through h=5.' }),
          }],
          isError: true,
        };
      }

      try {
        const result = await repo.upsertHorizon(userId, {
          id: params.id,
          horizon: params.horizon as 2 | 3 | 4 | 5,
          title: params.title,
          description: params.description,
          status: params.status,
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ horizon_item: result.item, created: result.created }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          isError: true,
        };
      }
    },
  );

  // -------------------------------------------------------------------------
  // list_horizons
  // -------------------------------------------------------------------------
  server.tool(
    'list_horizons',
    'List GTD horizon items by level. For h=2 (areas), includes linked project counts. Omit `horizon` to list every level (2–5) in one call.',
    {
      // ISS-021: `horizon` was required; the coach-scan skill calls it bare to see all levels.
      horizon: z.number().min(2).max(5).optional().describe('Horizon level: 2 (areas), 3 (goals), 4 (vision), 5 (purpose). Omit for all levels.'),
      status: z.enum(['active', 'completed', 'on_hold', 'dropped']).optional().describe('Filter by status. Default: active'),
      query: z.string().optional().describe('Free-text search in title and description'),
      limit: z.number().optional().describe('Max results. Default: 50 (per level when horizon is omitted)'),
      offset: z.number().optional().describe('Pagination offset. Default: 0 (ignored when horizon is omitted)'),
    },
    async (params) => {
      const userId = getUserId();
      if (params.horizon === undefined) {
        const levels = [2, 3, 4, 5] as const;
        const perLevel = await Promise.all(
          levels.map((horizon) =>
            repo.listHorizons(userId, { horizon, status: params.status, query: params.query, limit: params.limit }),
          ),
        );
        const horizons = perLevel.flatMap((r) => r.items);
        const total = perLevel.reduce((n, r) => n + r.total, 0);
        const byLevel = Object.fromEntries(levels.map((h, i) => [`h${h}`, perLevel[i].total]));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ horizons, total, by_level: byLevel }, null, 2),
          }],
        };
      }
      const result = await repo.listHorizons(userId, {
        horizon: params.horizon as 2 | 3 | 4 | 5,
        status: params.status,
        query: params.query,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ horizons: result.items, total: result.total }, null, 2),
        }],
      };
    },
  );
}
