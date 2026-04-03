import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerSleepTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_sleep_summary',
    'Get sleep data for a specific date or last night. Returns duration, stages, quality score, heart rate during sleep.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to last night (today\'s date).'),
    },
    async (params) => {
      const userId = getUserId();
      const date = params.date ?? todayDate();

      try {
        const result = await esClient.search({
          index: 'll5_health_sleep',
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
        });

        const hits = result.hits.hits;
        if (hits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: `No sleep data found for ${date}` }) }],
            isError: true,
          };
        }

        const doc = hits[0]._source as Record<string, unknown>;
        const durationSeconds = (doc.duration_seconds as number) || 0;

        const summary = {
          date: doc.date,
          source: doc.source,
          sleepTime: doc.sleep_time,
          wakeTime: doc.wake_time,
          durationHours: Math.round((durationSeconds / 3600) * 10) / 10,
          durationSeconds,
          stages: {
            deepSeconds: doc.deep_seconds,
            lightSeconds: doc.light_seconds,
            remSeconds: doc.rem_seconds,
            awakeSeconds: doc.awake_seconds,
            deepPct: durationSeconds > 0 ? Math.round(((doc.deep_seconds as number) || 0) / durationSeconds * 100) : 0,
            lightPct: durationSeconds > 0 ? Math.round(((doc.light_seconds as number) || 0) / durationSeconds * 100) : 0,
            remPct: durationSeconds > 0 ? Math.round(((doc.rem_seconds as number) || 0) / durationSeconds * 100) : 0,
            awakePct: durationSeconds > 0 ? Math.round(((doc.awake_seconds as number) || 0) / durationSeconds * 100) : 0,
          },
          qualityScore: doc.quality_score,
          averageHr: doc.average_hr ?? null,
          lowestHr: doc.lowest_hr ?? null,
          highestHr: doc.highest_hr ?? null,
          syncedAt: doc.synced_at,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ sleep: summary }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_sleep_summary] Failed', { userId, date, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get sleep data: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
