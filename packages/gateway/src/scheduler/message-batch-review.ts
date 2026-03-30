import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

interface MessageBatchConfig {
  intervalMinutes: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

interface MessageHit {
  _id: string;
  _source?: {
    sender?: string;
    app?: string;
    content?: string;
    is_group?: boolean;
    group_name?: string;
    timestamp?: string;
  };
}

/**
 * Periodic review of unprocessed messages from ES.
 * Groups messages by sender+app, sends a summary, and marks them as processed.
 */
export class MessageBatchReviewScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheckTime: number = 0;

  constructor(
    private es: Client,
    private pool: Pool,
    private config: MessageBatchConfig,
  ) {}

  start(): void {
    logger.info('Message batch review scheduler started', {
      intervalMinutes: this.config.intervalMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
      timezone: this.config.timezone,
    });
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentHour(): number {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: this.config.timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(new Date()), 10);
  }

  private isWithinActiveHours(): boolean {
    const hour = this.getCurrentHour();
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  private async tick(): Promise<void> {
    if (!this.isWithinActiveHours()) return;

    const now = Date.now();
    const intervalMs = this.config.intervalMinutes * 60 * 1000;
    if (now - this.lastCheckTime < intervalMs) return;

    try {
      this.lastCheckTime = now;

      // Query ES for unprocessed messages from this user within the last interval
      const since = new Date(now - intervalMs).toISOString();
      const response = await this.es.search({
        index: 'll5_awareness_messages',
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { processed: false } },
              { range: { timestamp: { gte: since } } },
            ],
          },
        },
        size: 500,
        sort: [{ timestamp: { order: 'asc' } }],
      });

      const hits = response.hits.hits as MessageHit[];
      if (hits.length === 0) {
        logger.debug('Message batch review: no unprocessed messages');
        return;
      }

      // Group by sender+app
      const groups = new Map<string, { sender: string; app: string; count: number }>();
      const docIds: string[] = [];

      for (const hit of hits) {
        if (!hit._source) continue;
        docIds.push(hit._id);
        const key = `${hit._source.sender ?? 'unknown'}|${hit._source.app ?? 'unknown'}`;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
        } else {
          groups.set(key, {
            sender: hit._source.sender ?? 'unknown',
            app: hit._source.app ?? 'unknown',
            count: 1,
          });
        }
      }

      // Build summary message
      const lines: string[] = [
        `[Message Batch Review] ${hits.length} unprocessed message${hits.length > 1 ? 's' : ''} from ${groups.size} sender${groups.size > 1 ? 's' : ''}:`,
      ];

      for (const group of groups.values()) {
        lines.push(`- ${group.sender} (${group.app}): ${group.count} message${group.count > 1 ? 's' : ''}`);
      }

      await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'));

      // Bulk update ES to mark messages as processed
      if (docIds.length > 0) {
        const bulkBody = docIds.flatMap((id) => [
          { update: { _index: 'll5_awareness_messages', _id: id } },
          { doc: { processed: true } },
        ]);
        await this.es.bulk({ body: bulkBody, refresh: false });
      }

      logger.info('Message batch review sent', {
        messages: hits.length,
        senders: groups.size,
      });
    } catch (err) {
      logger.warn('Message batch review tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
