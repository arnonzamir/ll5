"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface SchedulerSettings {
  active_hours_start: number;
  active_hours_end: number;
  morning_briefing_hour: number;
  calendar_review_minutes: number;
  tickler_alert_minutes: number;
  tickler_lookahead_hours: number;
  heartbeat_silence_minutes: number;
  journal_nudge_minutes: number;
  gtd_health_hours: number;
  weekly_review_day: number;
  weekly_review_hour: number;
  message_batch_minutes: number;
  consolidation_hour: number;
  schedule_lookback_hours: number;
  schedule_lookahead_hours: number;
}

export const DEFAULTS: SchedulerSettings = {
  active_hours_start: 7,
  active_hours_end: 22,
  morning_briefing_hour: 7,
  calendar_review_minutes: 120,
  tickler_alert_minutes: 60,
  tickler_lookahead_hours: 2,
  heartbeat_silence_minutes: 60,
  journal_nudge_minutes: 60,
  gtd_health_hours: 4,
  weekly_review_day: 0,
  weekly_review_hour: 14,
  message_batch_minutes: 30,
  consolidation_hour: 2,
  schedule_lookback_hours: 1,
  schedule_lookahead_hours: 3,
};

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

    const merged = { ...DEFAULTS } as Record<string, number>;
    for (const key of Object.keys(DEFAULTS)) {
      if (sched[key] != null) {
        merged[key] = sched[key] as number;
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
