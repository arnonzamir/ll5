import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { timeBanner, formatTime } from '@ll5/shared';
import { buildLocationLine } from './location-state.js';

interface HeartbeatConfig {
  silenceMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
  lookbackHours: number;  // default 1
  lookaheadHours: number; // default 3
}

/**
 * Heartbeat scheduler — nudges the agent with current time + schedule context
 * if no system messages have been sent for a configured period.
 * Includes upcoming events, overdue ticklers, and pending items.
 */
export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  // Edge-trigger state: the time-period and local date seen on the last tick,
  // so we can fire a transition cue exactly once when either flips. Null until
  // the first tick establishes a baseline (no spurious fire on startup).
  private lastPeriod: string | null = null;
  private lastDate: string | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: HeartbeatConfig,
  ) {}

  private timePeriod(hour: number): string {
    if (hour >= 6 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  }

  private localDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  /**
   * Points of change. Fires a transition system message — bypassing the silence
   * gate — when the time period flips (afternoon→evening …) or a new local day
   * starts, so the agent runs a fresh situation-check at the edges where the
   * user's situation actually shifts (not just after N minutes of silence). Each
   * edge fires at most once. Gated to active hours so a midnight rollover doesn't
   * ping; the new-day cue lands on the first active-hours tick of the day.
   */
  private async checkTransitions(hour: number): Promise<void> {
    const period = this.timePeriod(hour);
    const date = this.localDate();
    const inActiveHours = hour >= this.config.startHour && hour < this.config.endHour;

    // Establish baseline silently on the very first tick.
    if (this.lastPeriod === null || this.lastDate === null) {
      this.lastPeriod = period;
      this.lastDate = date;
      return;
    }

    const prevPeriod = this.lastPeriod;
    const newDay = date !== this.lastDate;
    const periodFlip = period !== this.lastPeriod;
    this.lastDate = date;
    this.lastPeriod = period;

    if (!inActiveHours || (!newDay && !periodFlip)) return;

    const banner = timeBanner(new Date(), this.config.timezone);
    const parts: string[] = [];
    if (newDay) {
      parts.push(`[New Day] ${banner}`);
      parts.push(
        'A new day started. Run the situation-check skill, and refresh your situational model for the day: call read_user_model() and recall the open narratives so you start on current context, not yesterday\'s.',
      );
    } else {
      parts.push(`[Transition] Time period is now ${period} (was ${prevPeriod}). ${banner}`);
      parts.push(
        'The user\'s situation likely shifted. Run the situation-check skill — pull get_situation (it carries time/location/activity/Bluetooth) and decide whether anything is worth surfacing now.',
      );
    }

    try {
      const evt = createSchedulerEvent(newDay ? 'new_day' : 'transition');
      await insertSystemMessage(this.pool, this.config.userId, parts.join('\n'), undefined, evt);
      logger.info('[HeartbeatScheduler][checkTransitions] Transition cue sent', { kind: newDay ? 'new_day' : 'transition', period });
    } catch (err) {
      logger.warn('[HeartbeatScheduler][checkTransitions] Failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  start(): void {
    logger.info('[HeartbeatScheduler][start] Heartbeat started', {
      silenceMinutes: this.config.silenceMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
      lookbackHours: this.config.lookbackHours,
      lookaheadHours: this.config.lookaheadHours,
    });
    this.timer = setInterval(() => void this.tick(), 5 * 60 * 1000);
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

  private async tick(): Promise<void> {
    const hour = this.getCurrentHour();

    // Edge-triggered transition cues run every tick (they self-gate to active
    // hours) and are independent of the silence-gated time check below.
    await this.checkTransitions(hour);

    if (hour < this.config.startHour || hour >= this.config.endHour) return;

    try {
      // Check when the last system message was sent
      const result = await this.pool.query<{ created_at: Date }>(
        `SELECT created_at FROM chat_messages
         WHERE user_id = $1 AND channel = 'system' AND direction = 'inbound'
         ORDER BY created_at DESC LIMIT 1`,
        [this.config.userId],
      );

      if (result.rows.length === 0) return;

      const lastMessage = result.rows[0].created_at;
      const silenceMs = Date.now() - new Date(lastMessage).getTime();
      const silenceMinutes = silenceMs / (60 * 1000);

      if (silenceMinutes < this.config.silenceMinutes) return;

      // Build data-rich message
      const now = new Date();
      const banner = timeBanner(now, this.config.timezone);

      const parts: string[] = [
        `[Time Check] ${banner}`,
        `Anchoring rule: every "local" you see is in ${this.config.timezone}; every "utc" is UTC. "today/yesterday/tomorrow" resolve in local. If a tool returned only ISO UTC, convert before talking to the user.`,
      ];

      // A2: include the user's current semantic place when known + recent.
      try {
        const locationLine = await buildLocationLine(this.es, this.config.userId, this.config.timezone);
        if (locationLine) parts.push(locationLine);
      } catch (err) {
        logger.debug('[HeartbeatScheduler][tick] location line skipped', { error: err instanceof Error ? err.message : String(err) });
      }

      // Query upcoming + recent events from ES
      const lookbackMs = this.config.lookbackHours * 60 * 60 * 1000;
      const lookaheadMs = this.config.lookaheadHours * 60 * 60 * 1000;
      const windowStart = new Date(now.getTime() - lookbackMs).toISOString();
      const windowEnd = new Date(now.getTime() + lookaheadMs).toISOString();

      try {
        const eventsResult = await this.es.search({
          index: 'll5_awareness_calendar_events',
          query: {
            bool: {
              filter: [
                { term: { user_id: this.config.userId } },
                { range: { start_time: { gte: windowStart, lte: windowEnd } } },
              ],
              must_not: [
                { term: { all_day: true } },
              ],
            },
          },
          size: 15,
          sort: [{ start_time: 'asc' }],
          _source: ['title', 'start_time', 'end_time', 'location', 'calendar_name', 'source'],
        });

        const events = eventsResult.hits.hits.map((h) => {
          const s = h._source as Record<string, unknown>;
          const startTime = new Date(s.start_time as string);
          const isPast = startTime < now;
          const diffMin = Math.round((startTime.getTime() - now.getTime()) / 60000);
          const t = formatTime(startTime, this.config.timezone);
          // Local "HH:MM Weekday" only — full date is implied by the banner above
          // and the "in N min / N min ago" relative anchor below removes ambiguity.
          const [, timePart, weekday] = t.local.split(' ');

          let status = '';
          if (isPast) {
            status = diffMin > -15 ? ' (just passed)' : ` (${Math.abs(diffMin)}min ago)`;
          } else if (diffMin <= 15) {
            status = ` (in ${diffMin}min!)`;
          } else if (diffMin <= 60) {
            status = ` (in ${diffMin}min)`;
          }

          const loc = s.location ? ` @ ${s.location}` : '';
          const cal = s.calendar_name ? ` [${s.calendar_name}]` : '';
          return `- ${weekday} ${timePart} ${s.title}${status}${loc}${cal}`;
        });

        if (events.length > 0) {
          parts.push('', `Schedule (${this.config.lookbackHours}h back, ${this.config.lookaheadHours}h ahead):`);
          parts.push(...events);
        } else {
          parts.push('', 'No events in the next few hours.');
        }
      } catch (err) {
        logger.warn('[HeartbeatScheduler][tick] ES event query failed', { error: err instanceof Error ? err.message : String(err) });
      }

      // Pending messages count
      try {
        const pendingResult = await this.pool.query<{ count: string }>(
          `SELECT COUNT(*) as count FROM chat_messages
           WHERE user_id = $1 AND direction = 'inbound' AND status = 'pending'`,
          [this.config.userId],
        );
        const pendingCount = parseInt(pendingResult.rows[0]?.count ?? '0', 10);
        if (pendingCount > 0) {
          parts.push('', `Pending: ${pendingCount} unprocessed message(s).`);
        }
      } catch (err) {
        // non-critical
      }

      // Unprocessed IM messages
      try {
        const unprocessedResult = await this.es.count({
          index: 'll5_awareness_messages',
          query: {
            bool: {
              filter: [
                { term: { user_id: this.config.userId } },
                { term: { processed: false } },
              ],
            },
          },
        });
        if (unprocessedResult.count > 0) {
          parts.push(`${unprocessedResult.count} unprocessed IM message(s) for batch review.`);
        }
      } catch (err) {
        // non-critical
      }

      // Phone health check — warn if no phone webhook received recently
      try {
        const lastPhoneResult = await this.es.search({
          index: 'll5_awareness_locations',
          query: { term: { user_id: this.config.userId } },
          size: 1,
          sort: [{ timestamp: 'desc' }],
          _source: ['timestamp'],
        });
        const lastPhoneTimestamp = (lastPhoneResult.hits.hits[0]?._source as Record<string, unknown>)?.timestamp as string | undefined;
        if (lastPhoneTimestamp) {
          const phoneAgeMin = Math.round((Date.now() - new Date(lastPhoneTimestamp).getTime()) / 60000);
          if (phoneAgeMin > 60) {
            parts.push('', `WARNING: No phone data received in ${phoneAgeMin > 120 ? Math.round(phoneAgeMin / 60) + 'h' : phoneAgeMin + 'min'}. The phone notification/location service may be dead. Push the user to open the LL5 app.`);
          }
        }
      } catch {
        // non-critical
      }

      parts.push('', 'If your user model feels stale or context was compacted, call read_user_model() to refresh.');
      parts.push('', 'Anything to push to the user?');

      const evt = createSchedulerEvent('heartbeat');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        parts.join('\n'),
        undefined,
        evt,
      );

      logger.info('[HeartbeatScheduler][tick] Time check sent', { banner, silence: Math.round(silenceMinutes) });
    } catch (err) {
      logger.warn('[HeartbeatScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
