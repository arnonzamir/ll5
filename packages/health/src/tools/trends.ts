import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

const METRIC_CONFIG: Record<string, { index: string; field: string }> = {
  sleep_duration: { index: 'll5_health_sleep', field: 'duration_seconds' },
  sleep_quality: { index: 'll5_health_sleep', field: 'quality_score' },
  resting_hr: { index: 'll5_health_heart_rate', field: 'resting_hr' },
  steps: { index: 'll5_health_daily_stats', field: 'steps' },
  stress: { index: 'll5_health_daily_stats', field: 'stress_average' },
  energy: { index: 'll5_health_daily_stats', field: 'energy_level' },
  weight: { index: 'll5_health_body_composition', field: 'weight_kg' },
  active_calories: { index: 'll5_health_daily_stats', field: 'active_calories' },
  hrv: { index: 'll5_health_daily_stats', field: 'hrv_last_night_avg' },
  vo2_max: { index: 'll5_health_daily_stats', field: 'vo2_max' },
};

const PERIOD_DAYS: Record<string, number> = {
  week: 7,
  month: 30,
  quarter: 90,
};

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function registerTrendTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  server.tool(
    'get_health_trends',
    'Get weekly or monthly trends for any health metric. Returns averages, min/max, and trend direction.',
    {
      metric: z.enum(['sleep_duration', 'sleep_quality', 'resting_hr', 'steps', 'stress', 'energy', 'weight', 'active_calories', 'hrv', 'vo2_max']).describe('Which metric to trend.'),
      period: z.enum(['week', 'month', 'quarter']).optional().describe('Trend period. Default: week.'),
      compare: z.boolean().optional().describe('Compare to previous period. Default: true.'),
    },
    async (params) => {
      const userId = getUserId();
      const period = params.period ?? 'week';
      const compare = params.compare ?? true;
      const config = METRIC_CONFIG[params.metric];

      const periodDays = PERIOD_DAYS[period];
      const currentFrom = daysAgo(periodDays);
      const currentTo = todayDate();

      try {
        // Query current period
        const currentResult = await esClient.search({
          index: config.index,
          size: 0,
          query: {
            bool: {
              filter: [
                { term: { user_id: userId } },
                { range: { date: { gte: currentFrom, lte: currentTo } } },
              ],
            },
          },
          aggs: {
            avg_value: { avg: { field: config.field } },
            min_value: { min: { field: config.field } },
            max_value: { max: { field: config.field } },
            daily: {
              date_histogram: {
                field: 'date',
                calendar_interval: 'day',
              },
              aggs: {
                value: { avg: { field: config.field } },
              },
            },
          },
        });

        const currentAggs = currentResult.aggregations as Record<string, { value: number | null; buckets?: Array<{ key_as_string: string; value: { value: number | null } }> }>;
        const currentAvg = currentAggs?.avg_value?.value;
        const currentMin = currentAggs?.min_value?.value;
        const currentMax = currentAggs?.max_value?.value;
        const dailyBuckets = currentAggs?.daily?.buckets ?? [];

        const trend: Record<string, unknown> = {
          metric: params.metric,
          period,
          from: currentFrom,
          to: currentTo,
          average: currentAvg != null ? Math.round(currentAvg * 10) / 10 : null,
          min: currentMin != null ? Math.round(currentMin * 10) / 10 : null,
          max: currentMax != null ? Math.round(currentMax * 10) / 10 : null,
          dataPoints: dailyBuckets.length,
          daily: dailyBuckets.map((b) => ({
            date: b.key_as_string,
            value: b.value?.value != null ? Math.round(b.value.value * 10) / 10 : null,
          })),
        };

        // Compare to previous period if requested
        if (compare) {
          const prevFrom = daysAgo(periodDays * 2);
          const prevTo = daysAgo(periodDays + 1);

          const prevResult = await esClient.search({
            index: config.index,
            size: 0,
            query: {
              bool: {
                filter: [
                  { term: { user_id: userId } },
                  { range: { date: { gte: prevFrom, lte: prevTo } } },
                ],
              },
            },
            aggs: {
              avg_value: { avg: { field: config.field } },
            },
          });

          const prevAggs = prevResult.aggregations as Record<string, { value: number | null }>;
          const prevAvg = prevAggs?.avg_value?.value;

          trend.previousPeriod = {
            from: prevFrom,
            to: prevTo,
            average: prevAvg != null ? Math.round(prevAvg * 10) / 10 : null,
          };

          if (currentAvg != null && prevAvg != null && prevAvg !== 0) {
            const changePct = ((currentAvg - prevAvg) / Math.abs(prevAvg)) * 100;
            trend.changePct = Math.round(changePct * 10) / 10;
            trend.direction = changePct > 1 ? 'up' : changePct < -1 ? 'down' : 'stable';
          }
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ trend }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[get_health_trends] Failed', { userId, metric: params.metric, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to get trends: ${message}` }) }],
          isError: true,
        };
      }
    },
  );
}
