"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface NotificationSettings {
  max_level: string;
  quiet_max_level: string;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
}

export async function fetchNotificationSettings(): Promise<NotificationSettings> {
  const token = await getToken();
  if (!token) return { max_level: "critical", quiet_max_level: "silent", quiet_start: "23:00", quiet_end: "07:00", timezone: "Asia/Jerusalem" };

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-notification-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { max_level: "critical", quiet_max_level: "silent", quiet_start: "23:00", quiet_end: "07:00", timezone: "Asia/Jerusalem" };
    return (await res.json()) as NotificationSettings;
  } catch (err) {
    console.error("[notification-levels] fetch failed:", err instanceof Error ? err.message : String(err));
    return { max_level: "critical", quiet_max_level: "silent", quiet_start: "23:00", quiet_end: "07:00", timezone: "Asia/Jerusalem" };
  }
}

export async function updateNotificationSettings(settings: Partial<NotificationSettings>): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const res = await fetch(`${env.GATEWAY_URL}/user-notification-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    return res.ok;
  } catch (err) {
    console.error("[notification-levels] update failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
