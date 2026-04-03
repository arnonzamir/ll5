import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerDailyStatsTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_daily_stats',
    'Get daily health stats: steps, calories, stress, body battery/energy, distance, floors for a date.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today.'),
    },
    async (params) => {
      const userId = getUserId();
      const date = params.date ?? todayDate();

      try {
        const result = await esClient.search({
          index: 'll5_health_daily_stats',
          query: {
            bool: {
              filter: [
                { term: { user_id: userId } },
                { term: { date } },
              ],
            },
          },
          size: 1,
          sort: [{ synced_at: 'desc' }],
          _source: { excludes: ['raw_data', 'stress_readings'] },
        });

        const hits = result.hits.hits;
        if (hits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `No daily stats found for ${date}` }) }],
            isError: true,
          };
        }

        const doc = hits[0]._source as Record<string, unknown>;

        const stats = {
          date: doc.date,
          source: doc.source,
          steps: doc.steps,
          distanceMeters: doc.distance_meters,
          distanceKm: doc.distance_meters != null ? Math.round(((doc.distance_meters as number) / 1000) * 10) / 10 : null,
          floorsClimbed: doc.floors_climbed ?? null,
          activeCalories: doc.active_calories,
          totalCalories: doc.total_calories,
          activeSeconds: doc.active_seconds,
          activeMinutes: doc.active_seconds != null ? Math.round((doc.active_seconds as number) / 60) : null,
          stress: {
            average: doc.stress_average ?? null,
            max: doc.stress_max ?? null,
          },
          energy: {
            level: doc.energy_level ?? null,
            min: doc.energy_min ?? null,
            max: doc.energy_max ?? null,
          },
          spo2Average: doc.spo2_average ?? null,
          respirationAverage: doc.respiration_average ?? null,
          syncedAt: doc.synced_at,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ dailyStats: stats }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_daily_stats] Failed', { userId, date, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get daily stats: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
