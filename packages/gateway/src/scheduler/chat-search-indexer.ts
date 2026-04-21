import type { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * Chat search indexer: tails the `chat_messages` and `chat_conversations`
 * NOTIFY channels and mirrors rows into Elasticsearch indices with the
 * Hebrew analyzer. PG remains the system of record; ES is the search
 * layer. If ES is down the gateway's /chat/conversations/search endpoint
 * falls back to ILIKE, so a stalled indexer degrades search quality but
 * doesn't take it offline.
 *
 * At-least-once semantics — indexing is keyed on message id so re-runs
 * are idempotent.
 */

const MESSAGES_INDEX = 'll5_chat_messages';
const CONVERSATIONS_INDEX = 'll5_chat_conversations';

const MESSAGES_MAPPING = {
  settings: {
    number_of_shards: 1,
    number_of_replicas: 1,
    analysis: {
      analyzer: {
        multilingual: {
          type: 'custom' as const,
          tokenizer: 'standard',
          filter: ['lowercase', 'asciifolding'],
        },
      },
    },
  },
  mappings: {
    properties: {
      user_id: { type: 'keyword' },
      conversation_id: { type: 'keyword' },
      channel: { type: 'keyword' },
      direction: { type: 'keyword' },
      role: { type: 'keyword' },
      content: { type: 'text', analyzer: 'multilingual' },
      reaction: { type: 'keyword' },
      reply_to_id: { type: 'keyword' },
      display_compact: { type: 'boolean' },
      created_at: { type: 'date' },
    },
  },
};

const CONVERSATIONS_MAPPING = {
  settings: MESSAGES_MAPPING.settings,
  mappings: {
    properties: {
      user_id: { type: 'keyword' },
      conversation_id: { type: 'keyword' },
      title: { type: 'text', analyzer: 'multilingual' },
      summary: { type: 'text', analyzer: 'multilingual' },
      archived_at: { type: 'date' },
      created_at: { type: 'date' },
      last_message_at: { type: 'date' },
      message_count: { type: 'integer' },
    },
  },
};

interface IndexerStats {
  started_at: string | null;
  connected_at: string | null;
  connected: boolean;
  reconnect_count: number;
  last_error: string | null;
  last_error_at: string | null;
}

const indexerStats: IndexerStats = {
  started_at: null,
  connected_at: null,
  connected: false,
  reconnect_count: 0,
  last_error: null,
  last_error_at: null,
};

export function getChatSearchIndexerStats(): IndexerStats {
  return { ...indexerStats };
}

export class ChatSearchIndexer {
  private listener: pg.Client | null = null;
  private stopping = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private connectionString: string,
  ) {}

  async start(): Promise<void> {
    indexerStats.started_at = new Date().toISOString();
    await this.ensureIndices();
    void this.connect();
    logger.info('[ChatSearchIndexer][start] Started');
  }

  stop(): void {
    this.stopping = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.listener) {
      this.listener.end().catch((err) => {
        logger.debug('[ChatSearchIndexer][stop] listener.end cleanup error (benign)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.listener = null;
    }
    indexerStats.connected = false;
  }

  private async ensureIndices(): Promise<void> {
    for (const [index, body] of [
      [MESSAGES_INDEX, MESSAGES_MAPPING],
      [CONVERSATIONS_INDEX, CONVERSATIONS_MAPPING],
    ] as const) {
      try {
        const exists = await this.es.indices.exists({ index });
        if (!exists) {
          await this.es.indices.create({ index, ...body });
          logger.info('[ChatSearchIndexer][ensureIndices] Created index', { index });
        }
      } catch (err) {
        logger.error('[ChatSearchIndexer][ensureIndices] Failed to ensure index', {
          index,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;

    try {
      const client = new pg.Client({ connectionString: this.connectionString });
      await client.connect();
      await client.query('LISTEN chat_messages');
      await client.query('LISTEN chat_conversations');
      this.listener = client;

      client.on('notification', (msg) => {
        const payload = msg.payload;
        if (!payload) return;
        if (msg.channel === 'chat_messages') {
          void this.handleMessageEvent(payload);
        } else if (msg.channel === 'chat_conversations') {
          void this.handleConversationEvent(payload);
        }
      });

      client.on('error', (err) => {
        indexerStats.last_error = err instanceof Error ? err.message : String(err);
        indexerStats.last_error_at = new Date().toISOString();
        logger.warn('[ChatSearchIndexer][connect] Listener error — reconnecting', {
          error: indexerStats.last_error,
          reconnect_count: indexerStats.reconnect_count,
        });
        this.scheduleReconnect();
      });

      client.on('end', () => {
        indexerStats.connected = false;
        if (!this.stopping) this.scheduleReconnect();
      });

      indexerStats.connected = true;
      indexerStats.connected_at = new Date().toISOString();
      logger.info('[ChatSearchIndexer][connect] LISTEN established', {
        reconnect_count: indexerStats.reconnect_count,
      });
    } catch (err) {
      indexerStats.last_error = err instanceof Error ? err.message : String(err);
      indexerStats.last_error_at = new Date().toISOString();
      logger.error('[ChatSearchIndexer][connect] Failed to connect', {
        error: indexerStats.last_error,
        reconnect_count: indexerStats.reconnect_count,
      });
      this.scheduleReconnect();
    }
  }

  /** Exponential backoff bounded at 60s. Reconnect storms should slow down. */
  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    if (this.listener) {
      this.listener.end().catch((err) => {
        logger.debug('[ChatSearchIndexer][scheduleReconnect] listener.end cleanup error (benign)', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.listener = null;
    }
    indexerStats.reconnect_count += 1;
    const delayMs = Math.min(60_000, 5_000 * Math.pow(2, Math.min(indexerStats.reconnect_count - 1, 4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
  }

  private async handleMessageEvent(payload: string): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }

    if (data.event !== 'new_message') return; // status updates aren't searchable

    // Reactions have null content — skip indexing.
    if (data.content == null) return;

    const id = data.id as string;
    if (!id) return;

    // Pull the full row from PG rather than trusting the NOTIFY payload
    // (it's truncated at 4000 chars and may miss user_id after the listen
    // handler strips it). Safe to re-read — the row is committed by the
    // time NOTIFY fires.
    try {
      const r = await this.pool.query<{
        id: string;
        user_id: string;
        conversation_id: string;
        channel: string;
        direction: string;
        role: string;
        content: string | null;
        reaction: string | null;
        reply_to_id: string | null;
        display_compact: boolean;
        created_at: string;
      }>(
        `SELECT id, user_id, conversation_id, channel, direction, role, content,
                reaction, reply_to_id, display_compact, created_at
           FROM chat_messages WHERE id = $1`,
        [id],
      );
      if (r.rows.length === 0) return;
      const row = r.rows[0];
      if (row.content == null) return;

      await this.es.index({
        index: MESSAGES_INDEX,
        id: row.id,
        document: {
          user_id: row.user_id,
          conversation_id: row.conversation_id,
          channel: row.channel,
          direction: row.direction,
          role: row.role,
          content: row.content,
          reaction: row.reaction,
          reply_to_id: row.reply_to_id,
          display_compact: row.display_compact,
          created_at: row.created_at,
        },
      });
    } catch (err) {
      logger.warn('[ChatSearchIndexer][handleMessage] Failed to index', {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleConversationEvent(payload: string): Promise<void> {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }

    const convId = data.conversation_id as string | undefined;
    if (!convId) return;

    try {
      const r = await this.pool.query<{
        conversation_id: string;
        user_id: string;
        title: string | null;
        summary: string | null;
        archived_at: string | null;
        created_at: string;
        last_message_at: string | null;
        message_count: number;
      }>(
        `SELECT conversation_id, user_id, title, summary, archived_at,
                created_at, last_message_at, message_count
           FROM chat_conversations WHERE conversation_id = $1`,
        [convId],
      );
      if (r.rows.length === 0) return;
      const row = r.rows[0];

      await this.es.index({
        index: CONVERSATIONS_INDEX,
        id: row.conversation_id,
        document: row,
      });
    } catch (err) {
      logger.warn('[ChatSearchIndexer][handleConversation] Failed to index', {
        conversation_id: convId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** One-shot backfill: index every chat_messages + chat_conversations row
   *  that isn't already in ES. Call manually after deploy; safe to re-run. */
  async backfill(): Promise<{ messages: number; conversations: number }> {
    let messages = 0;
    let conversations = 0;

    const convRes = await this.pool.query(
      `SELECT conversation_id, user_id, title, summary, archived_at,
              created_at, last_message_at, message_count
         FROM chat_conversations`,
    );
    for (const row of convRes.rows) {
      try {
        await this.es.index({ index: CONVERSATIONS_INDEX, id: row.conversation_id, document: row });
        conversations++;
      } catch (err) {
        logger.warn('[ChatSearchIndexer][backfill] conversation failed', {
          id: row.conversation_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Paginate messages by created_at to keep memory bounded.
    type MsgRow = {
      id: string;
      user_id: string;
      conversation_id: string;
      channel: string;
      direction: string;
      role: string;
      content: string | null;
      reaction: string | null;
      reply_to_id: string | null;
      display_compact: boolean;
      created_at: string;
    };
    const PAGE = 1000;
    let cursor: string | null = null;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const whereClause: string = cursor ? 'WHERE created_at < $1' : '';
      const pageParams: unknown[] = cursor ? [cursor] : [];
      const pageRes: { rows: MsgRow[] } = await this.pool.query<MsgRow>(
        `SELECT id, user_id, conversation_id, channel, direction, role, content,
                reaction, reply_to_id, display_compact, created_at
           FROM chat_messages
           ${whereClause}
          ORDER BY created_at DESC
          LIMIT ${PAGE}`,
        pageParams,
      );
      if (pageRes.rows.length === 0) break;

      const body = pageRes.rows
        .filter((r: MsgRow) => r.content != null)
        .flatMap((r: MsgRow) => [
          { index: { _index: MESSAGES_INDEX, _id: r.id } },
          {
            user_id: r.user_id,
            conversation_id: r.conversation_id,
            channel: r.channel,
            direction: r.direction,
            role: r.role,
            content: r.content,
            reaction: r.reaction,
            reply_to_id: r.reply_to_id,
            display_compact: r.display_compact,
            created_at: r.created_at,
          },
        ]);

      if (body.length > 0) {
        try {
          await this.es.bulk({ operations: body });
          messages += body.length / 2;
        } catch (err) {
          logger.warn('[ChatSearchIndexer][backfill] bulk failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (pageRes.rows.length < PAGE) break;
      cursor = pageRes.rows[pageRes.rows.length - 1].created_at;
    }

    logger.info('[ChatSearchIndexer][backfill] Complete', { messages, conversations });
    return { messages, conversations };
  }
}
