import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

// Tunable constants
const MIN_ACTIVITY_DURATION_SEC = 600;  // <10min activities not reported
const HR_ANOMALY_PCT = 15;              // Resting HR >15% above avg triggers alert
const SLEEP_SHORT_HOURS = 5;            // Sleep below this → notify
const SLEEP_QUALITY_LOW = 40;           // Quality score below this → notify
const STRESS_HIGH = 70;                 // Daily avg above this → notify
const ENERGY_LOW = 20;                  // Body battery below this → notify
const BASELINE_MIN_POINTS = 3;          // Min data points for conditional comparisons

interface HealthPollingConfig {
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

interface HealthPollingState {
  lastSeen: {
    sleep: string | null;
    heartRate: string | null;
    dailyStats: string | null;
    activities: string | null;
    bodyComposition: string | null;
  };
  reportedToday: Set<string>;
  currentDate: string | null;
}

export class HealthPollingScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private state: HealthPollingState = {
    lastSeen: { sleep: null, heartRate: null, dailyStats: null, activities: null, bodyComposition: null },
    reportedToday: new Set(),
    currentDate: null,
  };

  constructor(
    private es: Client,
    private pool: Pool,
    private config: HealthPollingConfig,
  ) {}

  start(): void {
    logger.info('[HealthPollingScheduler][start] Health polling started', {
      intervalMinutes: this.config.intervalMinutes,
    });
    // Initialize lastSeen from current max synced_at per index
    void this.initializeState();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentHour(): number {
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
      10,
    );
  }

  private getCurrentDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  private async getMaxSyncedAt(index: string): Promise<string | null> {
    try {
      const result = await this.es.search({
        index,
        query: { term: { user_id: this.config.userId } },
        size: 0,
        aggs: { max_synced: { max: { field: 'synced_at' } } },
      });
      const aggs = result.aggregations as Record<string, { value_as_string?: string }> | undefined;
      return aggs?.max_synced?.value_as_string ?? null;
    } catch {
      return null;
    }
  }

  private async initializeState(): Promise<void> {
    const [sleep, heartRate, dailyStats, activities, bodyComposition] = await Promise.all([
      this.getMaxSyncedAt('ll5_health_sleep'),
      this.getMaxSyncedAt('ll5_health_heart_rate'),
      this.getMaxSyncedAt('ll5_health_daily_stats'),
      this.getMaxSyncedAt('ll5_health_activities'),
      this.getMaxSyncedAt('ll5_health_body_composition'),
    ]);
    this.state.lastSeen = { sleep, heartRate, dailyStats, activities, bodyComposition };
    this.state.currentDate = this.getCurrentDate();
    logger.info('[HealthPollingScheduler][initializeState] State initialized', { lastSeen: this.state.lastSeen });
  }

  private async tick(): Promise<void> {
    const hour = this.getCurrentHour();
    if (hour < this.config.startHour || hour >= this.config.endHour) return;

    // Reset daily dedup on date change
    const today = this.getCurrentDate();
    if (this.state.currentDate !== today) {
      this.state.reportedToday.clear();
      this.state.currentDate = today;
    }

    try {
      const messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }> = [];

      await Promise.all([
        this.checkSleep(messages),
        this.checkActivities(messages),
        this.checkDailyStats(messages),
        this.checkHeartRate(messages),
        this.checkBodyComposition(messages),
      ]);

      if (messages.length === 0) return;

      // Determine highest notification level
      const levelOrder = { silent: 0, notify: 1, alert: 2 };
      const maxLevel = messages.reduce((max, m) => levelOrder[m.level] > levelOrder[max] ? m.level : max, 'silent' as 'silent' | 'notify' | 'alert');

      // Combine messages
      const combined = messages.length === 1
        ? messages[0].text
        : `[Health] Update:\n${messages.map(m => `- ${m.text.replace('[Health] ', '').replace('[Health Alert] ', '⚠ ')}`).join('\n')}`;

      const evt = createSchedulerEvent('health_polling');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        combined,
        maxLevel !== 'silent' ? { title: 'Health Update', type: 'health', priority: maxLevel === 'alert' ? 'high' : 'normal' } : undefined,
        evt,
      );

      logger.info('[HealthPollingScheduler][tick] Health update sent', { messageCount: messages.length, level: maxLevel });
    } catch (err) {
      logger.warn('[HealthPollingScheduler][tick] Failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async queryNew<T>(index: string, lastSeenKey: keyof HealthPollingState['lastSeen']): Promise<Array<{ _source: T; _id: string }>> {
    const lastSeen = this.state.lastSeen[lastSeenKey];
    const filter: Array<Record<string, unknown>> = [{ term: { user_id: this.config.userId } }];
    if (lastSeen) {
      filter.push({ range: { synced_at: { gt: lastSeen } } });
    }

    try {
      const result = await this.es.search<T>({
        index,
        query: { bool: { filter } },
        sort: [{ synced_at: 'desc' }],
        size: 10,
      });

      const hits = result.hits.hits as Array<{ _source: T; _id: string }>;

      // Update lastSeen to the newest synced_at
      if (hits.length > 0) {
        const newest = (hits[0]._source as Record<string, unknown>).synced_at as string;
        if (newest) this.state.lastSeen[lastSeenKey] = newest;
      }

      return hits;
    } catch {
      return [];
    }
  }

  private async checkSleep(messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }>): Promise<void> {
    interface SleepDoc { date: string; wake_time: string; duration_seconds: number; quality_score: number; deep_seconds: number; rem_seconds: number; synced_at: string }
    const hits = await this.queryNew<SleepDoc>('ll5_health_sleep', 'sleep');

    for (const hit of hits) {
      const s = hit._source;
      const dedupKey = `sleep:${s.date}`;
      if (this.state.reportedToday.has(dedupKey)) continue;
      this.state.reportedToday.add(dedupKey);

      const hours = (s.duration_seconds / 3600).toFixed(1);
      const deep = (s.deep_seconds / 3600).toFixed(1);
      const rem = (s.rem_seconds / 3600).toFixed(1);
      const wakeTime = s.wake_time ? new Date(s.wake_time).toLocaleTimeString('en-GB', { timeZone: this.config.timezone, hour: '2-digit', minute: '2-digit' }) : '?';
      const quality = Math.round(s.quality_score ?? 0);

      const isShort = s.duration_seconds / 3600 < SLEEP_SHORT_HOURS;
      const isLowQuality = quality > 0 && quality < SLEEP_QUALITY_LOW;

      if (isShort || isLowQuality) {
        messages.push({ text: `[Health] You woke up at ${wakeTime} after ${hours}h of sleep (quality: ${quality}). Deep: ${deep}h, REM: ${rem}h.`, level: 'notify' });
      } else {
        messages.push({ text: `[Health] You woke up at ${wakeTime} after ${hours}h of sleep (quality: ${quality}). Deep: ${deep}h, REM: ${rem}h.`, level: 'silent' });
      }
    }
  }

  private async checkActivities(messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }>): Promise<void> {
    interface ActivityDoc { source_id: string; activity_type: string; name: string; duration_seconds: number; distance_meters: number; calories: number; average_hr: number; synced_at: string }
    const hits = await this.queryNew<ActivityDoc>('ll5_health_activities', 'activities');

    for (const hit of hits) {
      const a = hit._source;
      if (a.duration_seconds < MIN_ACTIVITY_DURATION_SEC) continue;

      const dedupKey = `activity:${a.source_id || hit._id}`;
      if (this.state.reportedToday.has(dedupKey)) continue;
      this.state.reportedToday.add(dedupKey);

      const mins = Math.round(a.duration_seconds / 60);
      const km = a.distance_meters > 0 ? `, ${(a.distance_meters / 1000).toFixed(1)} km` : '';
      const hr = a.average_hr > 0 ? `, avg HR ${a.average_hr}` : '';
      const name = a.name || a.activity_type || 'Activity';

      messages.push({ text: `[Health] ${name} completed — ${mins} min${km}${hr}.`, level: 'silent' });
    }
  }

  private async checkDailyStats(messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }>): Promise<void> {
    interface DailyDoc { date: string; stress_average: number; energy_level: number; energy_min: number; steps: number; synced_at: string }
    const hits = await this.queryNew<DailyDoc>('ll5_health_daily_stats', 'dailyStats');

    for (const hit of hits) {
      const d = hit._source;
      const dedupKey = `daily:${d.date}`;
      if (this.state.reportedToday.has(dedupKey)) continue;
      this.state.reportedToday.add(dedupKey);

      // Check stress
      if (d.stress_average > 0 && d.stress_average > STRESS_HIGH) {
        messages.push({ text: `[Health] High stress day — avg ${Math.round(d.stress_average)} (threshold: ${STRESS_HIGH}).`, level: 'notify' });
      }

      // Check energy
      if (d.energy_level > 0 && d.energy_level < ENERGY_LOW) {
        messages.push({ text: `[Health] Low energy — body battery at ${Math.round(d.energy_level)} (min today: ${Math.round(d.energy_min ?? d.energy_level)}).`, level: 'notify' });
      }
    }
  }

  private async checkHeartRate(messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }>): Promise<void> {
    interface HRDoc { date: string; resting_hr: number; synced_at: string }
    const hits = await this.queryNew<HRDoc>('ll5_health_heart_rate', 'heartRate');

    for (const hit of hits) {
      const hr = hit._source;
      if (!hr.resting_hr || hr.resting_hr <= 0) continue;

      const dedupKey = `hr:${hr.date}`;
      if (this.state.reportedToday.has(dedupKey)) continue;
      this.state.reportedToday.add(dedupKey);

      // Compare with 7-day baseline
      try {
        const baseline = await this.es.search<HRDoc>({
          index: 'll5_health_heart_rate',
          query: {
            bool: {
              filter: [
                { term: { user_id: this.config.userId } },
                { range: { date: { gte: `now-7d/d`, lt: hr.date } } },
                { range: { resting_hr: { gt: 0 } } },
              ],
            },
          },
          size: 0,
          aggs: { avg_hr: { avg: { field: 'resting_hr' } }, count: { value_count: { field: 'resting_hr' } } },
        });
        const aggs = baseline.aggregations as Record<string, { value?: number }> | undefined;
        const avgHr = aggs?.avg_hr?.value;
        const count = aggs?.count?.value ?? 0;

        if (avgHr && count >= BASELINE_MIN_POINTS) {
          const pctAbove = ((hr.resting_hr - avgHr) / avgHr) * 100;
          if (pctAbove > HR_ANOMALY_PCT) {
            messages.push({
              text: `[Health Alert] Resting HR today is ${hr.resting_hr} bpm — ${Math.round(pctAbove)}% above your 7-day average of ${Math.round(avgHr)}.`,
              level: 'alert',
            });
          }
        }
      } catch {
        // Skip baseline comparison if query fails
      }
    }
  }

  private async checkBodyComposition(messages: Array<{ text: string; level: 'silent' | 'notify' | 'alert' }>): Promise<void> {
    interface BodyDoc { date: string; weight_kg: number; body_fat_pct: number; synced_at: string }
    const hits = await this.queryNew<BodyDoc>('ll5_health_body_composition', 'bodyComposition');

    for (const hit of hits) {
      const b = hit._source;
      const dedupKey = `body:${b.date}`;
      if (this.state.reportedToday.has(dedupKey)) continue;
      this.state.reportedToday.add(dedupKey);

      const weight = b.weight_kg?.toFixed(1);
      const fat = b.body_fat_pct ? `, ${b.body_fat_pct.toFixed(1)}% body fat` : '';
      if (weight) {
        messages.push({ text: `[Health] Weight logged: ${weight} kg${fat}.`, level: 'silent' });
      }
    }
  }
}
