"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface NotificationSettings {
  max_level: string;
  quiet_max_level: string;
  quiet_start: string;
  quiet_end: string;
}

export async function fetchNotificationSettings(): Promise<{ settings: NotificationSettings | null; error: string | null }> {
  const token = await getToken();
  if (!token) return { settings: null, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[notification-levels] fetch failed:", res.status, body);
      return { settings: null, error: `Server error (${res.status})` };
    }
    const all = (await res.json()) as Record<string, unknown>;
    const notif = (all.notification ?? {}) as Record<string, unknown>;
    return {
      settings: {
        max_level: (notif.max_level as string) ?? "critical",
        quiet_max_level: (notif.quiet_max_level as string) ?? "silent",
        quiet_start: (notif.quiet_start as string) ?? "23:00",
        quiet_end: (notif.quiet_end as string) ?? "07:00",
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[notification-levels] fetch failed:", msg);
    return { settings: null, error: msg };
  }
}

export async function updateNotificationSettings(settings: NotificationSettings): Promise<{ ok: boolean; error: string | null }> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ notification: settings }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[notification-levels] update failed:", res.status, body);
      return { ok: false, error: `Server error (${res.status}): ${body}` };
    }
    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[notification-levels] update failed:", msg);
    return { ok: false, error: msg };
  }
}
