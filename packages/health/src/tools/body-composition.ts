import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

export function registerBodyCompositionTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_body_composition',
    'Get latest weight and body composition data, or history over a date range.',
    {
      date: z.string().optional().describe('Specific date (YYYY-MM-DD). Defaults to latest available.'),
      from: z.string().optional().describe('Start date for history (YYYY-MM-DD).'),
      to: z.string().optional().describe('End date for history (YYYY-MM-DD).'),
    },
    async (params) => {
      const userId = getUserId();

      try {
        let dateFilter: Record<string, unknown> | undefined;
        const isRange = params.from || params.to;

        if (params.date) {
          dateFilter = { term: { date: params.date } };
        } else if (isRange) {
          const rangeClause: Record<string, string> = {};
          if (params.from) rangeClause.gte = params.from;
          if (params.to) rangeClause.lte = params.to;
          dateFilter = { range: { date: rangeClause } };
        }

        const filters: Record<string, unknown>[] = [{ term: { user_id: userId } }];
        if (dateFilter) filters.push(dateFilter);

        const result = await esClient.search({
          index: 'll5_health_body_composition',
          query: {
            bool: { filter: filters },
          },
          size: isRange ? 90 : 1,
          sort: [{ date: 'desc' }],
          _source: { excludes: ['raw_data'] },
        });

        const hits = result.hits.hits;
        if (hits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No body composition data found' }) }],
            isError: true,
          };
        }

        const records = hits.map((hit) => {
          const doc = hit._source as Record<string, unknown>;
          return {
            date: doc.date,
            source: doc.source,
            weightKg: doc.weight_kg ?? null,
            bodyFatPct: doc.body_fat_pct ?? null,
            muscleMassKg: doc.muscle_mass_kg ?? null,
            bmi: doc.bmi ?? null,
            boneMassKg: doc.bone_mass_kg ?? null,
            bodyWaterPct: doc.body_water_pct ?? null,
            syncedAt: doc.synced_at,
          };
        });

        // Single date or latest returns a single object; range returns an array
        if (!isRange) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ bodyComposition: records[0] }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ bodyComposition: records, count: records.length }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_body_composition] Failed', { userId, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get body composition data: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
