import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerHeartRateTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_heart_rate',
    'Get heart rate data for a date or date range. Returns resting HR, zones, min/max, and optionally continuous readings.',
    {
      date: z.string().optional().describe('Date in YYYY-MM-DD format. Defaults to today.'),
      from: z.string().optional().describe('Start date for range query (YYYY-MM-DD).'),
      to: z.string().optional().describe('End date for range query (YYYY-MM-DD).'),
      include_readings: z.boolean().optional().describe('Include continuous HR readings timeline. Default: false.'),
    },
    async (params) => {
      const userId = getUserId();
      const includeReadings = params.include_readings ?? false;

      try {
        let dateFilter: Record<string, unknown>;
        if (params.from && params.to) {
          dateFilter = { range: { date: { gte: params.from, lte: params.to } } };
        } else {
          const date = params.date ?? todayDate();
          dateFilter = { term: { date } };
        }

        const sourceExcludes = includeReadings ? [] : ['readings', 'raw_data'];

        const result = await esClient.search({
          index: 'll5_health_heart_rate',
          query: {
            bool: {
              filter: [
                { term: { user_id: userId } },
                dateFilter,
              ],
            },
          },
          size: 31, // max one month of daily data
          sort: [{ date: 'desc' }],
          _source: { excludes: sourceExcludes },
        });

        const hits = result.hits.hits;
        if (hits.length === 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No heart rate data found for the specified date(s)' }) }],
            isError: true,
          };
        }

        const records = hits.map((hit) => {
          const doc = hit._source as Record<string, unknown>;
          return {
            date: doc.date,
            source: doc.source,
            restingHr: doc.resting_hr,
            minHr: doc.min_hr,
            maxHr: doc.max_hr,
            averageHr: doc.average_hr,
            zones: {
              restSeconds: doc.zone_rest_seconds,
              z1Seconds: doc.zone_1_seconds,
              z2Seconds: doc.zone_2_seconds,
              z3Seconds: doc.zone_3_seconds,
              z4Seconds: doc.zone_4_seconds,
              z5Seconds: doc.zone_5_seconds,
            },
            ...(includeReadings ? { readings: doc.readings } : {}),
            syncedAt: doc.synced_at,
          };
        });

        // Single date returns a single object; range returns an array
        if (!params.from && !params.to) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ heartRate: records[0] }) }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ heartRate: records, count: records.length }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_heart_rate] Failed', { userId, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get heart rate data: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
