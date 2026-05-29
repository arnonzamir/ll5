import type {
  SleepData,
  HeartRateData,
  DailyStatsData,
  ActivityData,
  BodyCompositionData,
  StressData,
} from '../../types/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Normalizes raw Garmin sleep API response into the generic SleepData type.
 *
 * Garmin's getSleepData() returns a SleepData object with a `dailySleepDTO`
 * containing the actual sleep metrics.
 */
export function normalizeSleep(raw: unknown): SleepData | null {
  if (!raw) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = raw as any;
    const dto = data.dailySleepDTO ?? data;

    const sleepStartMs: number | undefined = dto.sleepStartTimestampGMT;
    const sleepEndMs: number | undefined = dto.sleepEndTimestampGMT;

    // Compute average and lowest HR from sleepHeartRate array if present
    let averageHr: number | undefined;
    let lowestHr: number | undefined;
    let highestHr: number | undefined;

    if (data.restingHeartRate) {
      averageHr = data.restingHeartRate;
    }

    if (Array.isArray(data.sleepHeartRate) && data.sleepHeartRate.length > 0) {
      const hrValues: number[] = data.sleepHeartRate
        .map((entry: { value?: number }) => entry.value)
        .filter((v: unknown): v is number => typeof v === 'number' && v > 0);

      if (hrValues.length > 0) {
        averageHr = Math.round(hrValues.reduce((a: number, b: number) => a + b, 0) / hrValues.length);
        lowestHr = Math.min(...hrValues);
        highestHr = Math.max(...hrValues);
      }
    }

    return {
      date: dto.calendarDate ?? '',
      sleepTime: sleepStartMs ? new Date(sleepStartMs).toISOString() : '',
      wakeTime: sleepEndMs ? new Date(sleepEndMs).toISOString() : '',
      durationSeconds: dto.sleepTimeSeconds ?? 0,
      deepSeconds: dto.deepSleepSeconds ?? 0,
      lightSeconds: dto.lightSleepSeconds ?? 0,
      remSeconds: dto.remSleepSeconds ?? 0,
      awakeSeconds: dto.awakeSleepSeconds ?? 0,
      qualityScore: dto.sleepScores?.overall?.value ?? 0,
      averageHr,
      lowestHr,
      highestHr,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeSleep] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Normalizes raw Garmin heart rate API response into the generic HeartRateData type.
 *
 * Garmin's getHeartRate() returns an object with min/max/resting HR and an array
 * of heart rate values throughout the day.
 */
export function normalizeHeartRate(raw: unknown): HeartRateData | null {
  if (!raw) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = raw as any;

    // Parse readings from heartRateValues (array of [timestamp, heartrate] or objects)
    const readings: Array<{ timestamp: string; value: number }> = [];
    if (Array.isArray(data.heartRateValues)) {
      for (const entry of data.heartRateValues) {
        if (Array.isArray(entry) && entry.length >= 2) {
          // [timestamp, heartrate] format
          const ts = entry[0];
          const hr = entry[1];
          if (typeof hr === 'number' && hr > 0) {
            readings.push({
              timestamp: typeof ts === 'number' ? new Date(ts).toISOString() : String(ts),
              value: hr,
            });
          }
        } else if (entry && typeof entry === 'object') {
          const ts = entry.timestamp ?? entry.startGMT;
          const hr = entry.heartrate ?? entry.value;
          if (typeof hr === 'number' && hr > 0) {
            readings.push({
              timestamp: typeof ts === 'number' ? new Date(ts).toISOString() : String(ts),
              value: hr,
            });
          }
        }
      }
    }

    // Calculate average from readings if available
    const validReadings = readings.filter((r) => r.value > 0);
    const avgHr =
      validReadings.length > 0
        ? Math.round(validReadings.reduce((sum, r) => sum + r.value, 0) / validReadings.length)
        : 0;

    return {
      date: data.calendarDate ?? '',
      restingHr: data.restingHeartRate ?? data.lastSevenDaysAvgRestingHeartRate ?? 0,
      minHr: data.minHeartRate ?? 0,
      maxHr: data.maxHeartRate ?? 0,
      averageHr: avgHr,
      // Garmin does not return zone durations directly in the HR endpoint;
      // provide zeros as defaults
      zones: { rest: 0, z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 },
      readings: readings.length > 0 ? readings : undefined,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeHeartRate] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Extract watch battery + last-sync from the /device-service devices list.
 * Battery field naming varies by model/API version, so we probe several known
 * spellings defensively and log the raw shape ONCE (info) for calibration —
 * once we confirm the field for this user's watch we can tighten this.
 */
/**
 * Watch name + last-sync from Garmin's mylastused endpoint.
 *
 * NOTE: Garmin's web Connect API does NOT expose the watch's live battery %
 * (confirmed for vívoactive 5 — devices/mylastused/primary-training-device
 * carry only capability flags like bodyBatteryCapable, no battery value; the
 * mobile app's battery comes from BLE, not the web API). So battery stays
 * undefined; we surface the device name + last sync, which ARE available.
 */
function extractDeviceStatus(lastUsedDevice?: unknown): { lastSync?: string; name?: string } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lu = (lastUsedDevice ?? {}) as any;
  const uploadMs = lu?.lastUsedDeviceUploadTime;
  return {
    lastSync: typeof uploadMs === 'number' ? new Date(uploadMs).toISOString() : undefined,
    name: lu?.lastUsedDeviceName ?? undefined,
  };
}

/**
 * Normalizes Garmin daily summary + steps data into the generic DailyStatsData type.
 *
 * This combines data from the daily summary endpoint and/or step counts.
 */
export function normalizeDailyStats(
  raw: unknown,
  stepsCount?: number | null,
  dateOverride?: string,
  extras?: { bodyBattery?: unknown; hrv?: unknown; vo2Max?: unknown; respiration?: unknown; lastUsedDevice?: unknown },
): DailyStatsData | null {
  if (!raw && stepsCount == null && !extras?.bodyBattery && !extras?.hrv) return null;

  const device = extractDeviceStatus(extras?.lastUsedDevice);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = (raw as any) ?? {};
    const summary = Array.isArray(data) ? data[0] : data;

    // Extract body battery from dedicated endpoint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bb = extras?.bodyBattery as any;
    const energyLevel = bb?.confirmedTotalSleepInSeconds != null
      ? (bb?.deltaValue ?? summary?.bodyBatteryChargedValue ?? undefined)
      : (summary?.bodyBatteryChargedValue ?? undefined);
    const energyMin = summary?.bodyBatteryDrainedValue ?? undefined;
    const energyMax = summary?.bodyBatteryHighestValue ?? (bb?.startTimestampLocal ? undefined : undefined);

    // Extract HRV from dedicated endpoint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hrvData = (extras?.hrv as any)?.hrvSummary;

    // Extract VO2 Max
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vo2 = extras?.vo2Max as any;

    // Extract respiration
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resp = extras?.respiration as any;

    // Active seconds source selection. Prefer the direct field, then highly-active
    // seconds, then derive from intensity minutes. The intensity-minutes branch is
    // guarded so an undefined moderateIntensityMinutes can never yield NaN.
    // (Bug: an unparenthesized `?? ?? a ? b : c` chain made `??` bind tighter than
    // `?:`, so the minutes computation ran whenever the chain was truthy — and went
    // NaN when moderateIntensityMinutes was undefined. LIVE: every doc had 0.)
    let activeSeconds: number;
    let activeSecondsSource: 'activeSeconds' | 'highlyActiveSeconds' | 'intensityMinutes' | 'none';
    if (summary?.activeSeconds != null) {
      activeSeconds = summary.activeSeconds;
      activeSecondsSource = 'activeSeconds';
    } else if (summary?.highlyActiveSeconds != null) {
      activeSeconds = summary.highlyActiveSeconds;
      activeSecondsSource = 'highlyActiveSeconds';
    } else if (summary?.moderateIntensityMinutes != null) {
      activeSeconds = ((summary.moderateIntensityMinutes ?? 0) + (summary.vigorousIntensityMinutes ?? 0)) * 60;
      activeSecondsSource = 'intensityMinutes';
    } else {
      activeSeconds = 0;
      activeSecondsSource = 'none';
    }

    logger.debug('[GarminNormalizer][normalizeDailyStats] active_seconds source selected', {
      date: summary?.calendarDate ?? dateOverride ?? '',
      activeSecondsSource,
      activeSeconds,
    });

    return {
      date: summary?.calendarDate ?? dateOverride ?? '',
      steps: stepsCount ?? summary?.totalSteps ?? 0,
      distanceMeters: summary?.totalDistanceMeters ?? summary?.totalDistance ?? 0,
      floorsClimbed: summary?.floorsAscended ?? summary?.floorsClimbed ?? undefined,
      activeCalories: summary?.activeKilocalories ?? summary?.activeCalories ?? 0,
      totalCalories: summary?.totalKilocalories ?? summary?.totalCalories ?? 0,
      activeSeconds,
      stressAverage: summary?.averageStressLevel ?? undefined,
      stressMax: summary?.maxStressLevel ?? undefined,
      energyLevel,
      energyMin,
      energyMax,
      hrvWeeklyAvg: hrvData?.weeklyAvg ?? undefined,
      hrvLastNightAvg: hrvData?.lastNightAvg ?? undefined,
      hrvStatus: hrvData?.status ?? undefined,
      vo2Max: vo2?.generic?.vo2MaxValue ?? undefined,
      respirationAvg: resp?.avgWakingRespirationValue ?? undefined,
      respirationMin: resp?.lowestRespirationValue ?? undefined,
      respirationMax: resp?.highestRespirationValue ?? undefined,
      deviceLastSync: device.lastSync,
      deviceName: device.name,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeDailyStats] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Normalizes a Garmin IActivity into the generic ActivityData type.
 */
export function normalizeActivity(raw: unknown): ActivityData | null {
  if (!raw) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const a = raw as any;

    const durationSec = a.duration
      ? Math.round(a.duration / 1000) // Garmin duration is in milliseconds
      : a.elapsedDuration
        ? Math.round(a.elapsedDuration / 1000)
        : 0;

    // Calculate end time from start + duration
    const startTime = a.startTimeGMT ?? a.startTimeLocal ?? '';
    let endTime = '';
    if (startTime && durationSec > 0) {
      const startMs = new Date(startTime).getTime();
      if (!isNaN(startMs)) {
        endTime = new Date(startMs + durationSec * 1000).toISOString();
      }
    }

    return {
      sourceActivityId: String(a.activityId ?? ''),
      activityType: a.activityType?.typeKey ?? a.sportTypeId?.toString() ?? 'unknown',
      name: a.activityName ?? '',
      startTime: startTime ? new Date(startTime).toISOString() : '',
      endTime,
      durationSeconds: durationSec,
      distanceMeters: a.distance != null ? a.distance : undefined,
      calories: a.calories != null ? a.calories : undefined,
      averageHr: a.averageHR != null ? a.averageHR : undefined,
      maxHr: a.maxHR != null ? a.maxHR : undefined,
      elevationGain: a.elevationGain != null ? a.elevationGain : undefined,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeActivity] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Normalizes raw Garmin weight data into the generic BodyCompositionData type.
 *
 * Garmin's getDailyWeightData() returns a WeightData object with `dateWeightList`.
 */
export function normalizeBodyComposition(raw: unknown, date: string): BodyCompositionData | null {
  if (!raw) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = raw as any;

    // The response has a dateWeightList array; find the matching date entry
    const weightList: unknown[] = data.dateWeightList ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entry = (weightList as any[]).find((w) => w.calendarDate === date) ?? (weightList as any[])[0];

    if (!entry) {
      return { date, weightKg: undefined, bodyFatPct: undefined, muscleMassKg: undefined, bmi: undefined };
    }

    // Garmin weight is in grams
    const weightGrams: number | null = entry.weight;
    const weightKg = weightGrams != null ? weightGrams / 1000 : undefined;

    return {
      date: entry.calendarDate ?? date,
      weightKg,
      bodyFatPct: entry.bodyFat != null ? entry.bodyFat : undefined,
      muscleMassKg: entry.muscleMass != null ? entry.muscleMass / 1000 : undefined,
      bmi: entry.bmi != null ? entry.bmi : undefined,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeBodyComposition] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}

/**
 * Normalizes raw Garmin stress data into the generic StressData type.
 *
 * The stress endpoint returns an object with stress values throughout the day.
 */
export function normalizeStress(raw: unknown, date: string): StressData | null {
  if (!raw) return null;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = raw as any;

    // Parse stress readings
    const readings: Array<{ timestamp: string; value: number }> = [];
    const stressValues: unknown[] = data.stressValuesArray ?? data.bodyStressValuesArray ?? [];

    for (const entry of stressValues) {
      if (Array.isArray(entry) && entry.length >= 2) {
        // [timestamp, value] format
        const ts = entry[0];
        const val = entry[1];
        if (typeof val === 'number' && val >= 0) {
          readings.push({
            timestamp: typeof ts === 'number' ? new Date(ts).toISOString() : String(ts),
            value: val,
          });
        }
      }
    }

    // Calculate average and max from readings, or use summary fields
    const validValues = readings.filter((r) => r.value > 0).map((r) => r.value);
    const avg =
      data.averageStressLevel ??
      (validValues.length > 0
        ? Math.round(validValues.reduce((a, b) => a + b, 0) / validValues.length)
        : 0);
    const max =
      data.maxStressLevel ??
      (validValues.length > 0 ? Math.max(...validValues) : 0);

    return {
      date: data.calendarDate ?? date,
      average: avg,
      max,
      readings: readings.length > 0 ? readings : undefined,
    };
  } catch (err) {
    logger.warn('[GarminNormalizer][normalizeStress] Failed to normalize', {
      error: String(err),
    });
    return null;
  }
}
