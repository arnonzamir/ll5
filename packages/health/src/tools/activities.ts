import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerActivityTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_activities',
    'Get recent workouts/activities. Returns type, duration, calories, heart rate, distance.',
    {
      from: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to 7 days ago.'),
      to: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
      activity_type: z.string().optional().describe('Filter by type: running, cycling, swimming, walking, strength, yoga, hiit, other.'),
      limit: z.number().min(1).max(50).optional().describe('Max results. Default: 10.'),
    },
    async (params) => {
      const userId = getUserId();
      const from = params.from ?? daysAgo(7);
      const to = params.to ?? todayDate();
      const limit = params.limit ?? 10;

      try {
        const filters: Record<string, unknown>[] = [
          { term: { user_id: userId } },
          { range: { start_time: { gte: from, lte: `${to}T23:59:59` } } },
        ];

        if (params.activity_type) {
          filters.push({ term: { activity_type: params.activity_type } });
        }

        const result = await esClient.search({
          index: 'll5_health_activities',
          query: {
            bool: { filter: filters },
          },
          size: limit,
          sort: [{ start_time: 'desc' }],
          _source: { excludes: ['raw_data'] },
        });

        const hits = result.hits.hits;
        const activities = hits.map((hit) => {
          const doc = hit._source as Record<string, unknown>;
          return {
            sourceId: doc.source_id,
            source: doc.source,
            activityType: doc.activity_type,
            name: doc.name,
            startTime: doc.start_time,
            endTime: doc.end_time,
            durationSeconds: doc.duration_seconds,
            durationMinutes: doc.duration_seconds != null ? Math.round((doc.duration_seconds as number) / 60) : null,
            distanceMeters: doc.distance_meters ?? null,
            distanceKm: doc.distance_meters != null ? Math.round(((doc.distance_meters as number) / 1000) * 100) / 100 : null,
            calories: doc.calories ?? null,
            averageHr: doc.average_hr ?? null,
            maxHr: doc.max_hr ?? null,
            averagePace: doc.average_pace ?? null,
            elevationGain: doc.elevation_gain ?? null,
            trainingEffect: doc.training_effect ?? null,
            zones: {
              z1Seconds: doc.zone_1_seconds ?? null,
              z2Seconds: doc.zone_2_seconds ?? null,
              z3Seconds: doc.zone_3_seconds ?? null,
              z4Seconds: doc.zone_4_seconds ?? null,
              z5Seconds: doc.zone_5_seconds ?? null,
            },
            syncedAt: doc.synced_at,
          };
        });

        const total = typeof result.hits.total === 'object' ? result.hits.total.value : result.hits.total;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ activities, count: activities.length, total }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_activities] Failed', { userId, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get activities: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
