import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface JournalHealthConfig {
  maxSilenceMinutes: number; // default 60 — nudge if no journal entry in this period
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Periodic check that the agent is actively journaling and staying proactive.
 *
 * If no journal entries have been written in maxSilenceMinutes, sends a system
 * message reminding the agent to journal AND reinforcing its proactive role.
 */
export class JournalHealthScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNudgeTime = 0;

  constructor(
    private es: Client,
    private pool: Pool,
    private config: JournalHealthConfig,
  ) {}

  start(): void {
    logger.info('[JournalHealthScheduler][start] Journal health check started', {
      maxSilenceMinutes: this.config.maxSilenceMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
    });
    // Check every 15 minutes
    this.timer = setInterval(() => void this.tick(), 15 * 60 * 1000);
    // First check after 5 minutes (let agent settle in)
    setTimeout(() => void this.tick(), 5 * 60 * 1000);
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

    // Don't nudge more than once per silence window
    const now = Date.now();
    if (now - this.lastNudgeTime < this.config.maxSilenceMinutes * 60 * 1000) return;

    try {
      const since = new Date(now - this.config.maxSilenceMinutes * 60 * 1000).toISOString();

      // Count journal entries in the silence window
      const journalResult = await this.es.count({
        index: 'll5_agent_journal',
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { range: { created_at: { gte: since } } },
            ],
          },
        },
      });

      if (journalResult.count > 0) {
        // Agent is journaling — no nudge needed
        return;
      }

      // Count messages processed in the same window
      const msgResult = await this.pool.query(
        `SELECT COUNT(*) FROM chat_messages
         WHERE user_id = $1 AND created_at > $2`,
        [this.config.userId, since],
      );
      const messageCount = parseInt(msgResult.rows[0].count, 10);

      // Build context-aware nudge
      const parts: string[] = [];

      if (messageCount > 0) {
        parts.push(
          `You've had ${messageCount} messages in the last ${this.config.maxSilenceMinutes} minutes but written 0 journal entries.`,
        );
      } else {
        parts.push(
          `No journal entries in the last ${this.config.maxSilenceMinutes} minutes.`,
        );
      }

      parts.push(
        'Reminder: journal observations, feedback, decisions, and patterns — even small ones.',
      );

      // Include upcoming events from ES
      try {
        const lookaheadMs = 3 * 60 * 60 * 1000;
        const windowEnd = new Date(now + lookaheadMs).toISOString();
        const eventsResult = await this.es.search({
          index: 'll5_awareness_calendar_events',
          query: {
            bool: {
              filter: [
                { term: { user_id: this.config.userId } },
                { range: { start_time: { gte: new Date().toISOString(), lte: windowEnd } } },
              ],
              must_not: [{ term: { all_day: true } }],
            },
          },
          size: 5,
          sort: [{ start_time: 'asc' }],
          _source: ['title', 'start_time'],
        });

        const upcoming = eventsResult.hits.hits.map((h) => {
          const s = h._source as Record<string, unknown>;
          const t = new Date(s.start_time as string).toLocaleTimeString('en-GB', {
            timeZone: this.config.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
          });
          return `- ${t} ${s.title}`;
        });

        if (upcoming.length > 0) {
          parts.push('', 'Upcoming:', ...upcoming);
        }
      } catch {
        // non-critical
      }

      parts.push(
        '',
        'Check:',
        '- Any pending inbox items to process?',
        '- Any system messages you haven\'t acted on?',
        '- Any conversations you\'re escalated on that need a decision?',
        '- Anything worth pushing to the user proactively?',
        '- If your user model feels stale or context was compacted, call read_user_model() to refresh.',
        '',
        'Your role is to be proactively helpful — don\'t wait to be asked.',
      );

      const evt = createSchedulerEvent('agent_nudge');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[Agent Nudge] ${parts.join('\n')}`,
        undefined,
        evt,
      );

      this.lastNudgeTime = now;

      logger.info('[JournalHealthScheduler][tick] Agent nudge sent', {
        messageCount,
        maxSilenceMinutes: this.config.maxSilenceMinutes,
      });
    } catch (err) {
      logger.warn('[JournalHealthScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
