"use server";

import { checkHealth } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

interface ServiceHealth {
  name: string;
  healthy: boolean;
  responseTime: number;
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

export interface HealthSnapshot {
  services: ServiceHealth[];
  channels: ChannelLiveness[];
  databases: { postgres: { healthy: boolean; error: string | null } };
  summary: { services_total: number; services_unhealthy: number; channels_stale: number };
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
          services: Array<{ name: string; healthy: boolean; response_time_ms: number }>;
          channels: ChannelLiveness[];
          databases: HealthSnapshot["databases"];
          summary: HealthSnapshot["summary"];
          checked_at: string;
        };
        return {
          services: data.services.map((s) => ({
            name: s.name,
            healthy: s.healthy,
            responseTime: s.response_time_ms,
          })),
          channels: data.channels,
          databases: data.databases,
          summary: data.summary,
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
    databases: { postgres: { healthy: false, error: "unknown (fallback mode)" } },
    summary: {
      services_total: results.length,
      services_unhealthy: results.filter((r) => !r.healthy).length,
      channels_stale: 0,
    },
    checked_at: new Date().toISOString(),
  };
}
