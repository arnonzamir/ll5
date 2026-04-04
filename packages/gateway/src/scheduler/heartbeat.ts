import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

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

  constructor(
    private pool: Pool,
    private es: Client,
    private config: HeartbeatConfig,
  ) {}

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
      const time = now.toLocaleTimeString('en-GB', {
        timeZone: this.config.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const day = now.toLocaleDateString('en-US', {
        timeZone: this.config.timezone,
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      });

      const parts: string[] = [`[Time Check] It's ${time}, ${day}.`];

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
          const timeStr = startTime.toLocaleTimeString('en-GB', {
            timeZone: this.config.timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });

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
          return `- ${timeStr} ${s.title}${status}${loc}${cal}`;
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

      parts.push('', 'Anything to push to the user?');

      const evt = createSchedulerEvent('heartbeat');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        parts.join('\n'),
        undefined,
        evt,
      );

      logger.info('[HeartbeatScheduler][tick] Time check sent', { time, silence: Math.round(silenceMinutes) });
    } catch (err) {
      logger.warn('[HeartbeatScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
