import { logger } from './utils/logger.js';

/**
 * RabbitMQ monitoring via the management HTTP API (DECISION-024).
 *
 * The broker image ships the management plugin on :15672. We derive the
 * management URL + creds from RABBITMQ_URL (amqp://user:pass@host:5672) and
 * return per-queue depth/consumer/rate stats + a peek at the dead-letter queue,
 * so the dashboard can show queue health without exposing the broker publicly.
 */

export interface QueueStat {
  name: string;
  messages: number;
  ready: number;
  unacked: number;
  consumers: number;
  publishRate: number;
  ackRate: number;
  state: string;
}

export interface DlqMessage {
  attempts: number | null;
  error: string | null;
  event: string | null;
  receivedAt: string | null;
}

export interface RabbitMqStats {
  reachable: boolean;
  queues: QueueStat[];
  dlqSample: DlqMessage[];
  error?: string;
}

/** Parse amqp://user:pass@host:port into the management API base + auth. */
function managementTarget(rabbitmqUrl: string): { base: string; user: string; pass: string } | null {
  try {
    const u = new URL(rabbitmqUrl);
    const host = u.hostname;
    // Management plugin listens on 15672 regardless of the AMQP port.
    return {
      base: `http://${host}:15672`,
      user: decodeURIComponent(u.username),
      pass: decodeURIComponent(u.password),
    };
  } catch {
    return null;
  }
}

function authHeader(user: string, pass: string): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

interface RawQueue {
  name: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
  state?: string;
  message_stats?: {
    publish_details?: { rate?: number };
    ack_details?: { rate?: number };
  };
}

/**
 * Fetch queue stats + a DLQ peek. Never throws — returns { reachable:false } on
 * any error so the endpoint degrades to "broker unavailable" instead of 500.
 */
export async function getRabbitMqStats(rabbitmqUrl: string | undefined): Promise<RabbitMqStats> {
  if (!rabbitmqUrl) {
    return { reachable: false, queues: [], dlqSample: [], error: 'RABBITMQ_URL not configured' };
  }
  const t = managementTarget(rabbitmqUrl);
  if (!t) {
    return { reachable: false, queues: [], dlqSample: [], error: 'invalid RABBITMQ_URL' };
  }
  const headers = { Authorization: authHeader(t.user, t.pass) };

  try {
    const res = await fetch(`${t.base}/api/queues/%2F`, { headers });
    if (!res.ok) {
      return { reachable: false, queues: [], dlqSample: [], error: `management API ${res.status}` };
    }
    const raw = (await res.json()) as RawQueue[];
    const queues: QueueStat[] = raw
      .filter((q) => q.name.startsWith('whatsapp'))
      .map((q) => ({
        name: q.name,
        messages: q.messages ?? 0,
        ready: q.messages_ready ?? 0,
        unacked: q.messages_unacknowledged ?? 0,
        consumers: q.consumers ?? 0,
        publishRate: q.message_stats?.publish_details?.rate ?? 0,
        ackRate: q.message_stats?.ack_details?.rate ?? 0,
        state: q.state ?? 'unknown',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Peek (non-destructive: ack_requeue_true) at up to 10 dead-lettered msgs.
    let dlqSample: DlqMessage[] = [];
    const dlq = queues.find((q) => q.name === 'whatsapp.dlq');
    if (dlq && dlq.messages > 0) {
      const peek = await fetch(`${t.base}/api/queues/%2F/whatsapp.dlq/get`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ count: 10, ackmode: 'ack_requeue_true', encoding: 'auto' }),
      });
      if (peek.ok) {
        const msgs = (await peek.json()) as Array<{ payload?: string }>;
        dlqSample = msgs.map((m) => {
          try {
            const p = JSON.parse(m.payload ?? '{}') as {
              attempts?: number;
              error?: string;
              payload?: { event?: string };
              receivedAt?: string;
            };
            return {
              attempts: p.attempts ?? null,
              error: p.error ?? null,
              event: p.payload?.event ?? null,
              receivedAt: p.receivedAt ?? null,
            };
          } catch {
            return { attempts: null, error: 'unparseable payload', event: null, receivedAt: null };
          }
        });
      }
    }

    return { reachable: true, queues, dlqSample };
  } catch (err) {
    logger.warn('[rabbitmqStats] fetch failed', { error: err instanceof Error ? err.message : String(err) });
    return { reachable: false, queues: [], dlqSample: [], error: 'broker unreachable' };
  }
}
