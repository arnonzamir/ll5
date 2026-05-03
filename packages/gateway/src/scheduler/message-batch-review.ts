import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

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
    conversation_id?: string;
    conversation_name?: string;
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
    logger.info('[MessageBatchReviewScheduler][start] Message batch review scheduler started', {
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

      // Query ES for ALL unprocessed messages (no time window — avoids orphaned messages)
      const response = await this.es.search({
        index: 'll5_awareness_messages',
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { processed: false } },
            ],
          },
        },
        size: 500,
        sort: [{ timestamp: { order: 'asc' } }],
      });

      const hits = response.hits.hits as MessageHit[];
      if (hits.length === 0) {
        logger.debug('[MessageBatchReviewScheduler][tick] No unprocessed messages');
        return;
      }

      // Group by sender+app+conversation so the agent can tell apart "John in
      // group X" from "John 1:1" and from "John in group Y". Conversation
      // attribution is the load-bearing context for whether/how to respond.
      interface Cluster {
        sender: string;
        app: string;
        is_group: boolean;
        conversation_name: string | null;
        conversation_id: string | null;
        count: number;
        firstSnippet: string | null;
        lastSnippet: string | null;
      }
      const groups = new Map<string, Cluster>();
      const docIds: string[] = [];

      for (const hit of hits) {
        if (!hit._source) continue;
        docIds.push(hit._id);
        const s = hit._source;
        const sender = s.sender ?? 'unknown';
        const app = s.app ?? 'unknown';
        const conv = s.conversation_id ?? (s.is_group ? (s.group_name ?? 'unknown-group') : 'direct');
        const key = `${sender}|${app}|${conv}`;
        const snippet = s.content ? (s.content.length > 80 ? s.content.slice(0, 80) + '…' : s.content) : null;
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
          if (snippet) existing.lastSnippet = snippet;
        } else {
          groups.set(key, {
            sender,
            app,
            is_group: !!s.is_group,
            conversation_name: s.conversation_name ?? s.group_name ?? null,
            conversation_id: s.conversation_id ?? null,
            count: 1,
            firstSnippet: snippet,
            lastSnippet: null,
          });
        }
      }

      // Build summary message — one line per (sender, conversation), with
      // group context inline and a snippet so the agent can decide whether
      // it needs to fetch more via read_messages.
      const lines: string[] = [
        `[Message Batch Review] ${hits.length} unprocessed message${hits.length > 1 ? 's' : ''} across ${groups.size} thread${groups.size > 1 ? 's' : ''}:`,
      ];

      for (const c of groups.values()) {
        const where = c.is_group
          ? ` in "${c.conversation_name ?? c.conversation_id ?? 'unknown group'}"`
          : '';
        const idTail = c.conversation_id ? ` [conv:${c.conversation_id}]` : '';
        const head = `- ${c.sender} (${c.app})${where}: ${c.count} message${c.count > 1 ? 's' : ''}${idTail}`;
        lines.push(head);
        if (c.firstSnippet) {
          lines.push(`    └ first: "${c.firstSnippet}"`);
        }
        if (c.count > 1 && c.lastSnippet && c.lastSnippet !== c.firstSnippet) {
          lines.push(`    └ last:  "${c.lastSnippet}"`);
        }
      }
      lines.push('');
      lines.push('Use read_messages with the platform + conversation_id to pull the full thread when something looks worth engaging.');

      const evt = createSchedulerEvent('message_batch');
      await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'), undefined, evt);

      // Bulk update ES to mark messages as processed
      if (docIds.length > 0) {
        const bulkBody = docIds.flatMap((id) => [
          { update: { _index: 'll5_awareness_messages', _id: id } },
          { doc: { processed: true } },
        ]);
        await this.es.bulk({ body: bulkBody, refresh: 'wait_for' });
      }

      logger.info('[MessageBatchReviewScheduler][tick] Message batch review sent', {
        messages: hits.length,
        senders: groups.size,
      });
    } catch (err) {
      logger.warn('[MessageBatchReviewScheduler][tick] Message batch review tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
