import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { getAdapter, listAdapters } from '../clients/registry.js';
import { decrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';
import type { SleepData, HeartRateData, DailyStatsData, ActivityData, BodyCompositionData, StressData } from '../types/index.js';

function yesterdayDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(from);
  const end = new Date(to);
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

async function writeSleepToES(esClient: Client, userId: string, sourceId: string, data: SleepData): Promise<void> {
  const docId = `${sourceId}-sleep-${userId}-${data.date}`;
  await esClient.index({
    index: 'll5_health_sleep',
    id: docId,
    document: {
      user_id: userId,
      source: sourceId,
      date: data.date,
      sleep_time: data.sleepTime,
      wake_time: data.wakeTime,
      duration_seconds: data.durationSeconds,
      deep_seconds: data.deepSeconds,
      light_seconds: data.lightSeconds,
      rem_seconds: data.remSeconds,
      awake_seconds: data.awakeSeconds,
      quality_score: data.qualityScore,
      average_hr: data.averageHr,
      lowest_hr: data.lowestHr,
      highest_hr: data.highestHr,
      synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  });
}

async function writeHeartRateToES(esClient: Client, userId: string, sourceId: string, data: HeartRateData): Promise<void> {
  const docId = `${sourceId}-hr-${userId}-${data.date}`;
  await esClient.index({
    index: 'll5_health_heart_rate',
    id: docId,
    document: {
      user_id: userId,
      source: sourceId,
      date: data.date,
      resting_hr: data.restingHr,
      min_hr: data.minHr,
      max_hr: data.maxHr,
      average_hr: data.averageHr,
      zone_rest_seconds: data.zones.rest,
      zone_1_seconds: data.zones.z1,
      zone_2_seconds: data.zones.z2,
      zone_3_seconds: data.zones.z3,
      zone_4_seconds: data.zones.z4,
      zone_5_seconds: data.zones.z5,
      readings: data.readings,
      synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  });
}

async function writeDailyStatsToES(esClient: Client, userId: string, sourceId: string, data: DailyStatsData): Promise<void> {
  const docId = `${sourceId}-daily-${userId}-${data.date}`;
  await esClient.index({
    index: 'll5_health_daily_stats',
    id: docId,
    document: {
      user_id: userId,
      source: sourceId,
      date: data.date,
      steps: data.steps,
      distance_meters: data.distanceMeters,
      floors_climbed: data.floorsClimbed,
      active_calories: data.activeCalories,
      total_calories: data.totalCalories,
      active_seconds: data.activeSeconds,
      stress_average: data.stressAverage,
      stress_max: data.stressMax,
      energy_level: data.energyLevel,
      energy_min: data.energyMin,
      energy_max: data.energyMax,
      hrv_weekly_avg: data.hrvWeeklyAvg,
      hrv_last_night_avg: data.hrvLastNightAvg,
      hrv_status: data.hrvStatus,
      vo2_max: data.vo2Max,
      respiration_average: data.respirationAvg,
      respiration_min: data.respirationMin,
      respiration_max: data.respirationMax,
      synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  });
}

async function writeActivityToES(esClient: Client, userId: string, sourceId: string, data: ActivityData): Promise<void> {
  const docId = `${sourceId}-activity-${data.sourceActivityId}`;
  await esClient.index({
    index: 'll5_health_activities',
    id: docId,
    document: {
      user_id: userId,
      source: sourceId,
      source_id: data.sourceActivityId,
      activity_type: data.activityType,
      name: data.name,
      start_time: data.startTime,
      end_time: data.endTime,
      duration_seconds: data.durationSeconds,
      distance_meters: data.distanceMeters,
      calories: data.calories,
      average_hr: data.averageHr,
      max_hr: data.maxHr,
      elevation_gain: data.elevationGain,
      synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  });
}

async function writeBodyCompToES(esClient: Client, userId: string, sourceId: string, data: BodyCompositionData): Promise<void> {
  const docId = `${sourceId}-bodycomp-${userId}-${data.date}`;
  await esClient.index({
    index: 'll5_health_body_composition',
    id: docId,
    document: {
      user_id: userId,
      source: sourceId,
      date: data.date,
      weight_kg: data.weightKg,
      body_fat_pct: data.bodyFatPct,
      muscle_mass_kg: data.muscleMassKg,
      bmi: data.bmi,
      synced_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
  });
}

async function writeStressToES(esClient: Client, userId: string, sourceId: string, data: StressData): Promise<void> {
  // Stress data is written into the daily stats index as supplementary fields
  const docId = `${sourceId}-daily-${userId}-${data.date}`;
  await esClient.update({
    index: 'll5_health_daily_stats',
    id: docId,
    doc: {
      stress_average: data.average,
      stress_max: data.max,
      stress_readings: data.readings,
      synced_at: new Date().toISOString(),
    },
    doc_as_upsert: true,
  });
}

export function registerSyncTools(
  server: McpServer,
  esClient: Client,
  pool: Pool,
  getUserId: () => string,
  encryptionKey: string,
): void {
  server.tool(
    'sync_health_data',
    'Manually trigger a sync of health data from connected sources. Pulls data for the specified date range.',
    {
      from: z.string().optional().describe('Start date (YYYY-MM-DD). Defaults to yesterday.'),
      to: z.string().optional().describe('End date (YYYY-MM-DD). Defaults to today.'),
      categories: z.array(z.enum(['sleep', 'heart_rate', 'daily_stats', 'activities', 'body_composition', 'stress'])).optional().describe('Which categories to sync. Defaults to all.'),
    },
    async (params) => {
      const userId = getUserId();
      const from = params.from ?? yesterdayDate();
      const to = params.to ?? todayDate();
      const categories = params.categories ?? ['sleep', 'heart_rate', 'daily_stats', 'activities', 'body_composition', 'stress'];

      // Get all connected sources for this user
      const credResult = await pool.query(
        'SELECT source_id, credentials FROM health_source_credentials WHERE user_id = $1',
        [userId],
      );

      if (credResult.rows.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No health sources connected. Use connect_health_source first.' }) }],
          isError: true,
        };
      }

      const results: Record<string, { synced: string[]; errors: string[] }> = {};
      const dates = dateRange(from, to);

      for (const row of credResult.rows) {
        const sourceId = row.source_id;
        const adapter = getAdapter(sourceId);
        if (!adapter) {
          results[sourceId] = { synced: [], errors: [`Adapter not registered for source: ${sourceId}`] };
          continue;
        }

        results[sourceId] = { synced: [], errors: [] };

        try {
          // Restore connection
          const creds = JSON.parse(decrypt(row.credentials, encryptionKey));
          await adapter.connect(userId, creds);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          results[sourceId].errors.push(`Connection failed: ${message}`);
          continue;
        }

        for (const date of dates) {
          // Sleep
          if (categories.includes('sleep')) {
            try {
              const sleep = await adapter.fetchSleep(userId, date);
              if (sleep) {
                await writeSleepToES(esClient, userId, sourceId, sleep);
                results[sourceId].synced.push(`sleep:${date}`);
              }
            } catch (err) {
              results[sourceId].errors.push(`sleep:${date}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Heart rate
          if (categories.includes('heart_rate')) {
            try {
              const hr = await adapter.fetchHeartRate(userId, date);
              if (hr) {
                await writeHeartRateToES(esClient, userId, sourceId, hr);
                results[sourceId].synced.push(`heart_rate:${date}`);
              }
            } catch (err) {
              results[sourceId].errors.push(`heart_rate:${date}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Daily stats
          if (categories.includes('daily_stats')) {
            try {
              const stats = await adapter.fetchDailyStats(userId, date);
              if (stats) {
                await writeDailyStatsToES(esClient, userId, sourceId, stats);
                results[sourceId].synced.push(`daily_stats:${date}`);
              }
            } catch (err) {
              results[sourceId].errors.push(`daily_stats:${date}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Body composition
          if (categories.includes('body_composition')) {
            try {
              const bodyComp = await adapter.fetchBodyComposition(userId, date);
              if (bodyComp) {
                await writeBodyCompToES(esClient, userId, sourceId, bodyComp);
                results[sourceId].synced.push(`body_composition:${date}`);
              }
            } catch (err) {
              results[sourceId].errors.push(`body_composition:${date}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }

          // Stress
          if (categories.includes('stress')) {
            try {
              const stress = await adapter.fetchStress(userId, date);
              if (stress) {
                await writeStressToES(esClient, userId, sourceId, stress);
                results[sourceId].synced.push(`stress:${date}`);
              }
            } catch (err) {
              results[sourceId].errors.push(`stress:${date}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        // Activities (date range, not per-day)
        if (categories.includes('activities')) {
          try {
            const activities = await adapter.fetchActivities(userId, from, to);
            for (const activity of activities) {
              await writeActivityToES(esClient, userId, sourceId, activity);
            }
            results[sourceId].synced.push(`activities:${activities.length}`);
          } catch (err) {
            results[sourceId].errors.push(`activities: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      const totalSynced = Object.values(results).reduce((sum, r) => sum + r.synced.length, 0);
      const totalErrors = Object.values(results).reduce((sum, r) => sum + r.errors.length, 0);

      logger.info('[sync_health_data] Sync completed', { userId, from, to, totalSynced, totalErrors });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ from, to, categories, results, totalSynced, totalErrors }) }],
      };
    },
  );
}
