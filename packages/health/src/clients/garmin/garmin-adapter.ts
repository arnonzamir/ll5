import type { HealthSourceAdapter } from '../adapter.js';
import { GarminClient } from './garmin-client.js';
import {
  normalizeSleep,
  normalizeHeartRate,
  normalizeDailyStats,
  normalizeActivity,
  normalizeBodyComposition,
  normalizeStress,
} from './garmin-normalizer.js';
import type {
  SleepData,
  HeartRateData,
  DailyStatsData,
  ActivityData,
  BodyCompositionData,
  StressData,
} from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export class GarminAdapter implements HealthSourceAdapter {
  readonly sourceId = 'garmin';
  readonly displayName = 'Garmin Connect';

  /** In-memory cache of authenticated GarminClient instances, keyed by userId. */
  private clients = new Map<string, GarminClient>();

  constructor(
    private pool: import('pg').Pool,
    private encryptionKey: string,
  ) {}

  /**
   * Connect to Garmin using email/password credentials.
   *
   * This is called both for initial connection (user provides email+password)
   * and for session restoration during sync (tools decrypt stored credentials
   * and call connect again).
   */
  async connect(userId: string, credentials: Record<string, string>): Promise<void> {
    const { email, password } = credentials;
    if (!email || !password) {
      throw new Error('Garmin credentials require "email" and "password" fields');
    }

    const client = new GarminClient();
    await client.login(email, password);
    this.clients.set(userId, client);
    logger.info('[GarminAdapter][connect] Connected', { userId });
  }

  async disconnect(userId: string): Promise<void> {
    this.clients.delete(userId);
    logger.info('[GarminAdapter][disconnect] Disconnected', { userId });
  }

  async getStatus(userId: string): Promise<{ connected: boolean; lastSync?: string }> {
    const client = this.clients.get(userId);
    return {
      connected: client?.isConnected() ?? false,
    };
  }

  async fetchSleep(userId: string, date: string): Promise<SleepData | null> {
    const client = this.getClient(userId);
    if (!client) return null;

    const raw = await client.getSleepData(date);
    return normalizeSleep(raw);
  }

  async fetchHeartRate(userId: string, date: string): Promise<HeartRateData | null> {
    const client = this.getClient(userId);
    if (!client) return null;

    const raw = await client.getHeartRate(date);
    return normalizeHeartRate(raw);
  }

  async fetchDailyStats(userId: string, date: string): Promise<DailyStatsData | null> {
    const client = this.getClient(userId);
    if (!client) return null;

    // Fetch both steps (named method) and daily summary (generic endpoint)
    const [steps, dailySummary] = await Promise.all([
      client.getSteps(date),
      client.getDailySummary(date),
    ]);

    return normalizeDailyStats(dailySummary, steps, date);
  }

  async fetchActivities(userId: string, from: string, to: string): Promise<ActivityData[]> {
    const client = this.getClient(userId);
    if (!client) return [];

    // Fetch a generous batch; the garmin-connect API returns activities
    // in reverse chronological order. We filter by date range after.
    const fromDate = new Date(from);
    const toDate = new Date(to);

    const activities: ActivityData[] = [];
    const batchSize = 50;
    let start = 0;
    let done = false;

    while (!done) {
      const batch = await client.getActivities(start, batchSize);
      if (batch.length === 0) break;

      for (const raw of batch) {
        const normalized = normalizeActivity(raw);
        if (!normalized) continue;

        const activityDate = new Date(normalized.startTime);
        if (isNaN(activityDate.getTime())) continue;

        // If the activity is before our date range, we've gone too far back
        if (activityDate < fromDate) {
          done = true;
          break;
        }

        // Include if within range
        if (activityDate <= toDate) {
          activities.push(normalized);
        }
      }

      start += batchSize;

      // Safety limit to avoid infinite loops
      if (start > 500) break;
    }

    return activities;
  }

  async fetchBodyComposition(userId: string, date: string): Promise<BodyCompositionData | null> {
    const client = this.getClient(userId);
    if (!client) return null;

    const raw = await client.getDailyWeight(date);
    return normalizeBodyComposition(raw, date);
  }

  async fetchStress(userId: string, date: string): Promise<StressData | null> {
    const client = this.getClient(userId);
    if (!client) return null;

    const raw = await client.getStressData(date);
    return normalizeStress(raw, date);
  }

  private getClient(userId: string): GarminClient | null {
    const client = this.clients.get(userId);
    if (!client) {
      logger.warn('[GarminAdapter] No active client for user', { userId });
      return null;
    }
    return client;
  }
}
