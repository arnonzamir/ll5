"use server";

import { mcpCallJsonSafe } from "@/lib/api";

// ---------- Types (generic, not source-specific) ----------

export interface HealthSource {
  sourceId: string;
  displayName: string;
  connected: boolean;
  lastCredentialUpdate: string | null;
}

export interface SleepSummary {
  date: string;
  source: string;
  sleepTime: string;
  wakeTime: string;
  durationHours: number;
  durationSeconds: number;
  stages: {
    deepSeconds: number;
    lightSeconds: number;
    remSeconds: number;
    awakeSeconds: number;
    deepPct: number;
    lightPct: number;
    remPct: number;
    awakePct: number;
  };
  qualityScore: number;
  averageHr: number | null;
  lowestHr: number | null;
  highestHr: number | null;
  syncedAt: string;
}

export interface HeartRateRecord {
  date: string;
  source: string;
  restingHr: number;
  minHr: number;
  maxHr: number;
  averageHr: number;
  zones: {
    restSeconds: number;
    z1Seconds: number;
    z2Seconds: number;
    z3Seconds: number;
    z4Seconds: number;
    z5Seconds: number;
  };
  syncedAt: string;
}

export interface DailyStats {
  date: string;
  source: string;
  steps: number;
  distanceMeters: number;
  distanceKm: number | null;
  floorsClimbed: number | null;
  activeCalories: number;
  totalCalories: number;
  activeSeconds: number;
  activeMinutes: number | null;
  stress: { average: number | null; max: number | null };
  energy: { level: number | null; min: number | null; max: number | null };
  spo2Average: number | null;
  respirationAverage: number | null;
  syncedAt: string;
}

export interface ActivityRecord {
  sourceId: string;
  source: string;
  activityType: string;
  name: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  durationMinutes: number | null;
  distanceMeters: number | null;
  distanceKm: number | null;
  calories: number | null;
  averageHr: number | null;
  maxHr: number | null;
  elevationGain: number | null;
  syncedAt: string;
}

export interface BodyCompositionRecord {
  date: string;
  source: string;
  weightKg: number | null;
  bodyFatPct: number | null;
  muscleMassKg: number | null;
  bmi: number | null;
  syncedAt: string;
}

export interface TrendData {
  metric: string;
  period: string;
  from: string;
  to: string;
  average: number | null;
  min: number | null;
  max: number | null;
  dataPoints: number;
  daily: Array<{ date: string; value: number | null }>;
  previousPeriod?: { from: string; to: string; average: number | null };
  changePct?: number;
  direction?: "up" | "down" | "stable";
}

// ---------- Fetchers ----------

export async function fetchHealthSources(): Promise<HealthSource[]> {
  const data = await mcpCallJsonSafe<{ sources: HealthSource[] }>("health", "list_health_sources");
  return data?.sources ?? [];
}

export async function fetchSleepSummary(date?: string): Promise<SleepSummary | null> {
  const args: Record<string, unknown> = {};
  if (date) args.date = date;
  const data = await mcpCallJsonSafe<{ sleep: SleepSummary }>("health", "get_sleep_summary", args);
  return data?.sleep ?? null;
}

export async function fetchHeartRate(params: { date?: string; from?: string; to?: string } = {}): Promise<HeartRateRecord | HeartRateRecord[] | null> {
  const data = await mcpCallJsonSafe<{ heartRate: HeartRateRecord | HeartRateRecord[] }>("health", "get_heart_rate", params);
  return data?.heartRate ?? null;
}

export async function fetchDailyStats(date?: string): Promise<DailyStats | null> {
  const args: Record<string, unknown> = {};
  if (date) args.date = date;
  const data = await mcpCallJsonSafe<{ dailyStats: DailyStats }>("health", "get_daily_stats", args);
  return data?.dailyStats ?? null;
}

export async function fetchActivities(params: { from?: string; to?: string; activity_type?: string; limit?: number } = {}): Promise<ActivityRecord[]> {
  const data = await mcpCallJsonSafe<{ activities: ActivityRecord[] }>("health", "get_activities", params);
  return data?.activities ?? [];
}

export async function fetchBodyComposition(params: { date?: string; from?: string; to?: string } = {}): Promise<BodyCompositionRecord | BodyCompositionRecord[] | null> {
  const data = await mcpCallJsonSafe<{ bodyComposition: BodyCompositionRecord | BodyCompositionRecord[] }>("health", "get_body_composition", params);
  return data?.bodyComposition ?? null;
}

export async function fetchHealthTrend(metric: string, period?: string): Promise<TrendData | null> {
  const args: Record<string, unknown> = { metric };
  if (period) args.period = period;
  const data = await mcpCallJsonSafe<{ trend: TrendData }>("health", "get_health_trends", args);
  return data?.trend ?? null;
}

export async function connectHealthSource(sourceId: string, credentials: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  const data = await mcpCallJsonSafe<{ success?: boolean; error?: string }>("health", "connect_health_source", { source_id: sourceId, credentials });
  if (data?.success) return { success: true };
  return { success: false, error: data?.error ?? "Connection failed" };
}

export async function disconnectHealthSource(sourceId: string): Promise<{ success: boolean; error?: string }> {
  const data = await mcpCallJsonSafe<{ success?: boolean; error?: string }>("health", "disconnect_health_source", { source_id: sourceId });
  if (data?.success) return { success: true };
  return { success: false, error: data?.error ?? "Disconnect failed" };
}

export async function syncHealthData(params: { from?: string; to?: string; categories?: string[] } = {}): Promise<{ totalSynced: number; totalErrors: number; results: Record<string, { synced: string[]; errors: string[] }> }> {
  const data = await mcpCallJsonSafe<{ totalSynced: number; totalErrors: number; results: Record<string, { synced: string[]; errors: string[] }> }>("health", "sync_health_data", params);
  return data ?? { totalSynced: 0, totalErrors: 0, results: {} };
}
