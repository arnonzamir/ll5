import amqp from 'amqplib';
import type { ConfirmChannel, Channel, ConsumeMessage } from 'amqplib';
import { logger } from './logger.js';

/**
 * WhatsApp ingestion queue (DECISION-024).
 *
 * Evolution delivers WhatsApp events to the gateway over a fast-ack webhook;
 * the ingress publishes each event here and returns 200 immediately. A worker
 * consumes and processes at its own pace. This decouples Evolution's serial
 * webhook delivery from our processing so a single slow/poison message can no
 * longer head-of-line-block the whole feed (the 2026-07-06 outage: an oversized
 * base64 media payload 413'd, Evolution retried it 10x, and every text message
 * behind it stalled for ~2h).
 *
 * Topology (all durable):
 *   exchange `whatsapp` (direct)
 *     └─ key `ingest` ─→ queue `whatsapp.ingest`   (the worker consumes this)
 *   queue `whatsapp.retry`  — x-message-ttl + dead-letters back to `ingest`
 *   queue `whatsapp.dlq`    — terminal parking for poison / max-retry messages
 *
 * Failure isolation: a message that throws is republished to `whatsapp.retry`
 * (TTL backoff, then re-delivered) up to MAX_ATTEMPTS, after which it is parked
 * in `whatsapp.dlq` and the feed keeps flowing.
 *
 * Degradation: if RABBITMQ_URL is unset or the broker is unreachable, publish()
 * returns false and the ingress processes inline (today's behaviour) so nothing
 * is ever lost — the queue is a resilience layer, not a hard dependency.
 */

export interface QueuedEvent {
  /** Resolved LL5 user the instance maps to. */
  userId: string;
  /** Raw Evolution webhook payload: { event, instance, data }. */
  payload: unknown;
  /** ISO timestamp the gateway received it. */
  receivedAt: string;
  /** Retry counter (incremented on each failed dispatch). */
  attempts?: number;
}

export type EventHandler = (evt: QueuedEvent) => Promise<void>;

const EXCHANGE = 'whatsapp';
const ROUTING_KEY = 'ingest';
const MAIN_QUEUE = 'whatsapp.ingest';
const RETRY_QUEUE = 'whatsapp.retry';
const DLQ = 'whatsapp.dlq';
const RETRY_TTL_MS = 15_000;
const MAX_ATTEMPTS = 5;
const PREFETCH = 20;

export class WhatsAppQueue {
  private conn: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  private pubChannel: ConfirmChannel | null = null;
  private conChannel: Channel | null = null;
  private connecting = false;
  private closed = false;
  private handler: EventHandler | null = null;
  private reconnectDelay = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string | undefined) {}

  isEnabled(): boolean {
    return typeof this.url === 'string' && this.url.length > 0;
  }

  /** Establish the connection + topology, and (if a handler is given) start the
   *  consumer worker. Safe to call once at startup; reconnects itself after. */
  async start(handler?: EventHandler): Promise<void> {
    if (!this.isEnabled()) {
      logger.warn('[whatsappQueue] RABBITMQ_URL unset — queue disabled, ingress will process inline');
      return;
    }
    if (handler) this.handler = handler;
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting || this.closed || !this.url) return;
    this.connecting = true;
    try {
      const conn = await amqp.connect(this.url);
      this.conn = conn;
      conn.on('error', (e: unknown) =>
        logger.error('[whatsappQueue] connection error', { error: e instanceof Error ? e.message : String(e) }),
      );
      conn.on('close', () => {
        if (!this.closed) this.scheduleReconnect('connection closed');
      });

      // Assert topology on a throwaway channel.
      const setup = await conn.createChannel();
      await setup.assertExchange(EXCHANGE, 'direct', { durable: true });
      await setup.assertQueue(DLQ, { durable: true });
      await setup.assertQueue(RETRY_QUEUE, {
        durable: true,
        arguments: {
          'x-message-ttl': RETRY_TTL_MS,
          'x-dead-letter-exchange': EXCHANGE,
          'x-dead-letter-routing-key': ROUTING_KEY,
        },
      });
      await setup.assertQueue(MAIN_QUEUE, { durable: true });
      await setup.bindQueue(MAIN_QUEUE, EXCHANGE, ROUTING_KEY);
      await setup.close();

      // Publisher on a confirm channel so publish() only resolves once the
      // broker has durably accepted the message.
      this.pubChannel = await conn.createConfirmChannel();

      // Consumer worker.
      if (this.handler) {
        const ch = await conn.createChannel();
        await ch.prefetch(PREFETCH);
        this.conChannel = ch;
        await ch.consume(
          MAIN_QUEUE,
          (msg) =>
            void this.onMessage(msg).catch((err: unknown) =>
              // A channel that drops mid-message can make ack/sendToQueue throw;
              // the unacked message just redelivers. Log, never crash the process.
              logger.error('[whatsappQueue] onMessage failed', {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          { noAck: false },
        );
      }

      this.reconnectDelay = 1000;
      logger.info('[whatsappQueue] connected', { consumer: !!this.handler, prefetch: PREFETCH });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 406 PRECONDITION_FAILED = a durable queue already exists with different
      // args than we assert (e.g. RETRY_TTL_MS changed). connect() then loops
      // forever and publish() silently falls back to inline processing — the
      // exact serial behaviour the queue removes. Make it LOUD, not silent.
      const code = (err as { code?: number } | null)?.code;
      if (code === 406 || /PRECONDITION_FAILED/i.test(msg)) {
        logger.error(
          '[whatsappQueue] TOPOLOGY CONFLICT (406) — queue args differ from a pre-existing durable queue. ' +
            'The queue is DISABLED (inline fallback active). Version the queue name or delete the stale queue.',
          { error: msg },
        );
      } else {
        logger.error('[whatsappQueue] connect failed', { error: msg });
      }
      this.scheduleReconnect('connect failed');
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(reason: string): void {
    this.pubChannel = null;
    this.conChannel = null;
    this.conn = null;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    logger.warn('[whatsappQueue] reconnecting', { reason, delayMs: delay });
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  /**
   * Publish an event to the ingest queue. Returns false when the broker is
   * unavailable so the caller can fall back to inline processing (no loss).
   */
  async publish(evt: QueuedEvent): Promise<boolean> {
    const ch = this.pubChannel;
    if (!this.url || !ch) return false;
    try {
      const buf = Buffer.from(JSON.stringify(evt));
      ch.publish(EXCHANGE, ROUTING_KEY, buf, { persistent: true, contentType: 'application/json' });
      await ch.waitForConfirms();
      return true;
    } catch (err) {
      logger.error('[whatsappQueue] publish failed', { error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  private async onMessage(msg: ConsumeMessage | null): Promise<void> {
    const ch = this.conChannel;
    if (!msg || !ch) return;

    let evt: QueuedEvent;
    try {
      evt = JSON.parse(msg.content.toString()) as QueuedEvent;
    } catch {
      logger.error('[whatsappQueue] undecodable message → DLQ');
      ch.sendToQueue(DLQ, msg.content, { persistent: true });
      ch.ack(msg);
      return;
    }

    try {
      if (this.handler) await this.handler(evt);
      ch.ack(msg);
    } catch (err) {
      const attempts = (evt.attempts ?? 0) + 1;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (attempts <= MAX_ATTEMPTS) {
        ch.sendToQueue(RETRY_QUEUE, Buffer.from(JSON.stringify({ ...evt, attempts })), { persistent: true });
        logger.warn('[whatsappQueue] dispatch failed → retry', { attempts, error: errMsg });
      } else {
        ch.sendToQueue(DLQ, Buffer.from(JSON.stringify({ ...evt, attempts, error: errMsg })), { persistent: true });
        logger.error('[whatsappQueue] dispatch failed → DLQ (max attempts exceeded)', { attempts, error: errMsg });
      }
      ch.ack(msg);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.conn?.close();
    } catch {
      /* ignore */
    }
  }
}
