"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { DEFAULTS, type SchedulerSettings } from "./scheduler-types";

export async function fetchSchedulerSettings(): Promise<{ settings: SchedulerSettings; error: string | null }> {
  const token = await getToken();
  if (!token) return { settings: DEFAULTS, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { settings: DEFAULTS, error: `Server error (${res.status})` };
    const raw = (await res.json()) as Record<string, unknown>;
    const sched = (raw.scheduler ?? {}) as Record<string, unknown>;

    const merged = { ...DEFAULTS } as Record<string, number | boolean>;
    for (const key of Object.keys(DEFAULTS)) {
      if (sched[key] != null) {
        merged[key] = sched[key] as number | boolean;
      }
    }
    return { settings: merged as unknown as SchedulerSettings, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { settings: DEFAULTS, error: msg };
  }
}

export async function updateSchedulerSettings(settings: SchedulerSettings): Promise<{ ok: boolean; error: string | null }> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scheduler: settings }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Server error (${res.status}): ${body}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
