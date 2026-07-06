"use server";

import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

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

/** Poll the gateway's /admin/rabbitmq (WhatsApp ingest queue health). */
export async function pollRabbitMq(): Promise<RabbitMqStats> {
  const token = await getToken();
  if (!token) {
    return { reachable: false, queues: [], dlqSample: [], error: "not authenticated" };
  }
  try {
    const res = await fetch(`${env.GATEWAY_URL}/admin/rabbitmq`, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 0 },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) {
      return { reachable: false, queues: [], dlqSample: [], error: `gateway ${res.status}` };
    }
    return (await res.json()) as RabbitMqStats;
  } catch (err) {
    return {
      reachable: false,
      queues: [],
      dlqSample: [],
      error: err instanceof Error ? err.message : "request failed",
    };
  }
}
