import type {
  SleepData,
  HeartRateData,
  DailyStatsData,
  ActivityData,
  BodyCompositionData,
  StressData,
} from '../types/index.js';

export interface HealthSourceAdapter {
  readonly sourceId: string;
  readonly displayName: string;

  connect(userId: string, credentials: Record<string, string>): Promise<void>;
  disconnect(userId: string): Promise<void>;
  getStatus(userId: string): Promise<{ connected: boolean; lastSync?: string }>;

  fetchSleep(userId: string, date: string): Promise<SleepData | null>;
  fetchHeartRate(userId: string, date: string): Promise<HeartRateData | null>;
  fetchDailyStats(userId: string, date: string): Promise<DailyStatsData | null>;
  fetchActivities(userId: string, from: string, to: string): Promise<ActivityData[]>;
  fetchBodyComposition(userId: string, date: string): Promise<BodyCompositionData | null>;
  fetchStress(userId: string, date: string): Promise<StressData | null>;
}
