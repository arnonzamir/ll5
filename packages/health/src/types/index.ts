export interface SleepData {
  date: string;
  sleepTime: string;
  wakeTime: string;
  durationSeconds: number;
  deepSeconds: number;
  lightSeconds: number;
  remSeconds: number;
  awakeSeconds: number;
  qualityScore: number;
  averageHr?: number;
  lowestHr?: number;
  highestHr?: number;
}

export interface HeartRateData {
  date: string;
  restingHr: number;
  minHr: number;
  maxHr: number;
  averageHr: number;
  zones: { rest: number; z1: number; z2: number; z3: number; z4: number; z5: number };
  readings?: Array<{ timestamp: string; value: number }>;
}

export interface DailyStatsData {
  date: string;
  steps: number;
  distanceMeters: number;
  floorsClimbed?: number;
  activeCalories: number;
  totalCalories: number;
  activeSeconds: number;
  stressAverage?: number;
  stressMax?: number;
  energyLevel?: number;
  energyMin?: number;
  energyMax?: number;
  hrvWeeklyAvg?: number;
  hrvLastNightAvg?: number;
  hrvStatus?: string;
  vo2Max?: number;
  respirationAvg?: number;
  respirationMin?: number;
  respirationMax?: number;
}

export interface StressData {
  date: string;
  average: number;
  max: number;
  readings?: Array<{ timestamp: string; value: number }>;
}

export interface ActivityData {
  sourceActivityId: string;
  activityType: string;
  name: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  averageHr?: number;
  maxHr?: number;
  elevationGain?: number;
}

export interface BodyCompositionData {
  date: string;
  weightKg?: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  bmi?: number;
}

// Health source config (stored in auth_users.settings)
export interface HealthSourceConfig {
  enabled: boolean;
  metrics: {
    sleep: boolean;
    heart_rate: boolean;
    daily_stats: boolean;
    activities: boolean;
    stress: boolean;
    body_composition: boolean;
  };
}

export interface HealthConfig {
  enabled: boolean;
  sources: Record<string, HealthSourceConfig>;
}
