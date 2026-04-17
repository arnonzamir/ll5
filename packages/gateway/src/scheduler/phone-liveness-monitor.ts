import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';

interface PhoneLivenessConfig {
  /** How often to check (minutes). */
  intervalMinutes: number;
  /** Alert if phone has been silent for this many hours during active hours. */
  stalenessHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

export interface PhoneLivenessSnapshot {
  userId: string;
  last_location_at: string | null;
  last_status_at: string | null;
  last_signal_at: string | null;
  last_signal_age_hours: number | null;
  stale: boolean;
  checked_at: string;
}

const CACHED_SNAPSHOT: Map<string, PhoneLivenessSnapshot> = new Map();

export function getPhoneLivenessSnapshot(userId: string): PhoneLivenessSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

export function getAllPhoneLivenessSnapshots(): PhoneLivenessSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

/**
 * Phone liveness monitor — alerts when the Android app stops pushing data.
 *
 * The DeviceHeartbeatWorker is supposed to push phone_status at least every
 * hour regardless of movement, and GPS flows when the user moves. If neither
 * index has received anything in N hours during active hours, the phone's
 * notification/location service has almost certainly died — the user won't
 * see in-app alerts and GPS-based automations break. Promote the existing
 * heartbeat-message string warning into an actual FCM critical so they're
 * nudged to open the app without needing to read the agent conversation.
 */
export class PhoneLivenessMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertAt: number = 0;
  private alertCount: number = 0;
  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000;
  private readonly MAX_ALERTS_PER_EPISODE = 2;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: PhoneLivenessConfig,
  ) {}

  start(): void {
    logger.info('[PhoneLivenessMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      stalenessHours: this.config.stalenessHours,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
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

  private async lastTimestamp(index: string): Promise<string | null> {
    try {
      const res = await this.es.search<{ timestamp: string }>({
        index,
        size: 1,
        sort: [{ timestamp: { order: 'desc' } }],
        query: { term: { user_id: this.config.userId } },
        _source: ['timestamp'],
      });
      return res.hits?.hits?.[0]?._source?.timestamp ?? null;
    } catch (err) {
      // Index might not exist yet — not fatal
      logger.debug('[PhoneLivenessMonitor][lastTimestamp] Query failed', {
        index, error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async tick(): Promise<void> {
    try {
      const [locTs, statusTs] = await Promise.all([
        this.lastTimestamp('ll5_awareness_locations'),
        this.lastTimestamp('ll5_awareness_phone_statuses'),
      ]);

      const locMs = locTs ? new Date(locTs).getTime() : null;
      const statusMs = statusTs ? new Date(statusTs).getTime() : null;
      const signalMs = Math.max(locMs ?? 0, statusMs ?? 0) || null;
      const signalTs = signalMs === locMs ? locTs : statusTs;
      const ageHours = signalMs !== null ? (Date.now() - signalMs) / (3600 * 1000) : null;
      const stale = ageHours === null || ageHours > this.config.stalenessHours;

      const snapshot: PhoneLivenessSnapshot = {
        userId: this.config.userId,
        last_location_at: locTs,
        last_status_at: statusTs,
        last_signal_at: signalTs,
        last_signal_age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
        stale,
        checked_at: new Date().toISOString(),
      };
      CACHED_SNAPSHOT.set(this.config.userId, snapshot);

      if (!stale) {
        if (this.alertCount > 0) {
          logger.info('[PhoneLivenessMonitor][tick] Phone recovered, resetting alert counter', { alertCount: this.alertCount });
          this.alertCount = 0;
        }
        logger.debug('[PhoneLivenessMonitor][tick] Phone alive', snapshot as unknown as Record<string, unknown>);
        return;
      }

      const hour = this.getCurrentHour();
      if (hour < this.config.startHour || hour >= this.config.endHour) {
        logger.info('[PhoneLivenessMonitor][tick] Phone stale outside active hours — not alerting', snapshot as unknown as Record<string, unknown>);
        return;
      }

      if (this.alertCount >= this.MAX_ALERTS_PER_EPISODE) {
        logger.debug('[PhoneLivenessMonitor][tick] Stale but max alerts reached', { alertCount: this.alertCount });
        return;
      }
      if (Date.now() - this.lastAlertAt < this.ALERT_COOLDOWN_MS) {
        logger.debug('[PhoneLivenessMonitor][tick] Stale but within cooldown', snapshot as unknown as Record<string, unknown>);
        return;
      }
      this.lastAlertAt = Date.now();
      this.alertCount += 1;

      logger.error('[PhoneLivenessMonitor][alert] Phone pipeline stalled', snapshot as unknown as Record<string, unknown>);

      const bodyAge = ageHours === null
        ? 'no phone data on record'
        : `last signal ${Math.round(ageHours)}h ago`;

      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 phone pipeline stalled',
        body: `No GPS or phone_status in ${Math.round(this.config.stalenessHours)}h+ (${bodyAge}). Open LL5 on the phone to restart the service.`,
        type: 'phone_liveness_stall',
        notification_level: 'critical',
        data: {
          last_signal_at: signalTs ?? '',
          age_hours: ageHours === null ? '' : String(Math.round(ageHours)),
        },
      });
    } catch (err) {
      logger.warn('[PhoneLivenessMonitor][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
