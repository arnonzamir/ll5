"use server";

import { checkHealth } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

interface ServiceHealth {
  name: string;
  healthy: boolean;
  responseTime: number;
  statusCode?: number | null;
  error?: string | null;
  consecutiveFailures?: number;
  lastHealthyAt?: string | null;
  lastCheckedAt?: string | null;
}

export interface ChannelLiveness {
  userId: string;
  pending_inbound: number;
  oldest_pending_age_seconds: number | null;
  last_outbound_at: string | null;
  last_delivered_at: string | null;
  stale: boolean;
  checked_at: string;
}

export interface WhatsAppFlowSnapshot {
  userId: string;
  account_count: number;
  last_message_at: string | null;
  last_message_age_hours: number | null;
  stale: boolean;
  checked_at: string;
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

export interface AgentOutputSnapshot {
  userId: string;
  system_inbound_lookback: number;
  last_agent_outbound_at: string | null;
  hours_since_last_outbound: number | null;
  stale: boolean;
  checked_at: string;
}

export interface HealthSnapshot {
  services: ServiceHealth[];
  channels: ChannelLiveness[];
  whatsapp: WhatsAppFlowSnapshot[];
  phones: PhoneLivenessSnapshot[];
  agent_output: AgentOutputSnapshot[];
  databases: { postgres: { healthy: boolean; error: string | null } };
  summary: {
    services_total: number;
    services_unhealthy: number;
    channels_stale: number;
    whatsapp_stale: number;
    phones_stale: number;
    agent_output_stale: number;
  };
  checked_at: string;
}

/**
 * Fetch the aggregate health snapshot from the gateway's /admin/health endpoint.
 * Falls back to direct /health pings for the 7 services if the aggregator is unreachable.
 */
export async function pollHealth(): Promise<HealthSnapshot> {
  const token = await getToken();
  if (token) {
    try {
      const res = await fetch(`${env.GATEWAY_URL}/admin/health`, {
        headers: { Authorization: `Bearer ${token}` },
        next: { revalidate: 0 },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          services: Array<{
            name: string;
            healthy: boolean;
            response_time_ms: number;
            status_code?: number | null;
            error?: string | null;
            consecutive_failures?: number;
            last_healthy_at?: string | null;
            last_checked_at?: string | null;
          }>;
          channels: ChannelLiveness[];
          whatsapp?: WhatsAppFlowSnapshot[];
          phones?: PhoneLivenessSnapshot[];
          agent_output?: AgentOutputSnapshot[];
          databases: HealthSnapshot["databases"];
          summary: Partial<HealthSnapshot["summary"]> & HealthSnapshot["summary"];
          checked_at: string;
        };
        return {
          services: data.services.map((s) => ({
            name: s.name,
            healthy: s.healthy,
            responseTime: s.response_time_ms,
            statusCode: s.status_code ?? null,
            error: s.error ?? null,
            consecutiveFailures: s.consecutive_failures ?? 0,
            lastHealthyAt: s.last_healthy_at ?? null,
            lastCheckedAt: s.last_checked_at ?? null,
          })),
          channels: data.channels,
          whatsapp: data.whatsapp ?? [],
          phones: data.phones ?? [],
          agent_output: data.agent_output ?? [],
          databases: data.databases,
          summary: {
            services_total: data.summary?.services_total ?? data.services.length,
            services_unhealthy: data.summary?.services_unhealthy ?? 0,
            channels_stale: data.summary?.channels_stale ?? 0,
            whatsapp_stale: data.summary?.whatsapp_stale ?? 0,
            phones_stale: data.summary?.phones_stale ?? 0,
            agent_output_stale: data.summary?.agent_output_stale ?? 0,
          },
          checked_at: data.checked_at,
        };
      }
    } catch (err) {
      console.error("[pollHealth] /admin/health failed, falling back to direct pings:", err instanceof Error ? err.message : String(err));
    }
  }

  // Fallback: ping all 7 services directly.
  const servers = ["gateway", "knowledge", "gtd", "awareness", "ll5-calendar", "ll5-messaging", "health"] as const;
  const results = await Promise.all(
    servers.map(async (name) => {
      const { healthy, responseTime } = await checkHealth(name);
      return { name, healthy, responseTime };
    }),
  );
  return {
    services: results,
    channels: [],
    whatsapp: [],
    phones: [],
    agent_output: [],
    databases: { postgres: { healthy: false, error: "unknown (fallback mode)" } },
    summary: {
      services_total: results.length,
      services_unhealthy: results.filter((r) => !r.healthy).length,
      channels_stale: 0,
      whatsapp_stale: 0,
      phones_stale: 0,
      agent_output_stale: 0,
    },
    checked_at: new Date().toISOString(),
  };
}
