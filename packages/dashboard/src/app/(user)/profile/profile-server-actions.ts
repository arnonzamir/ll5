"use server";

import { redirect } from "next/navigation";
import { getToken, clearToken, decodeTokenPayload } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";

interface UserInfo {
  userId: string;
  role: string;
  name: string;
  expiresAt: string | null;
}

export async function getUserInfo(): Promise<UserInfo | null> {
  const token = await getToken();
  if (!token) return null;

  const payload = decodeTokenPayload(token);
  if (!payload) return null;

  const exp = payload.exp
    ? new Date((payload.exp as number) * 1000).toISOString()
    : null;

  return {
    userId: (payload.sub ?? payload.user_id ?? "") as string,
    role: (payload.role ?? "user") as string,
    name: (payload.name ?? payload.sub ?? payload.user_id ?? "") as string,
    expiresAt: exp,
  };
}

interface KnowledgeProfile {
  name?: string;
  timezone?: string;
  location?: string;
  bio?: string;
}

export async function getDisplayName(): Promise<string> {
  try {
    const data = await mcpCallJsonSafe<{ profile: KnowledgeProfile | null }>(
      "knowledge",
      "get_profile"
    );
    return data?.profile?.name ?? "";
  } catch (err) {
    console.error("[profile] getDisplayName failed:", err instanceof Error ? err.message : String(err));
    return "";
  }
}

export async function updateDisplayName(name: string): Promise<{ success: boolean; name: string }> {
  try {
    const data = await mcpCallJsonSafe<{ profile: KnowledgeProfile }>(
      "knowledge",
      "update_profile",
      { name }
    );
    return { success: true, name: data?.profile?.name ?? name };
  } catch (err) {
    console.error("[profile] updateDisplayName failed:", err instanceof Error ? err.message : String(err));
    return { success: false, name };
  }
}

export interface UserSettings {
  timezone: string;
  work_week: {
    start_day: number; // 0=Sunday, 1=Monday, ...
    start_hour: string; // "09:00"
    end_hour: string;   // "17:00"
  };
}

const DEFAULT_SETTINGS: UserSettings = {
  timezone: "Asia/Jerusalem",
  work_week: { start_day: 0, start_hour: "09:00", end_hour: "17:00" },
};

export async function getUserSettings(): Promise<{ settings: UserSettings; error: string | null }> {
  const token = await getToken();
  if (!token) return { settings: DEFAULT_SETTINGS, error: "Not authenticated" };

  try {
    const { env } = await import("@/lib/env");
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { settings: DEFAULT_SETTINGS, error: `Server error (${res.status}): ${body}` };
    }
    const raw = (await res.json()) as Record<string, unknown>;
    const ww = (raw.work_week ?? {}) as Record<string, unknown>;
    return {
      settings: {
        timezone: (raw.timezone as string) ?? DEFAULT_SETTINGS.timezone,
        work_week: {
          start_day: (ww.start_day as number) ?? DEFAULT_SETTINGS.work_week.start_day,
          start_hour: (ww.start_hour as string) ?? DEFAULT_SETTINGS.work_week.start_hour,
          end_hour: (ww.end_hour as string) ?? DEFAULT_SETTINGS.work_week.end_hour,
        },
      },
      error: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[profile] getUserSettings failed:", msg);
    return { settings: DEFAULT_SETTINGS, error: msg };
  }
}

export async function updateUserSettings(patch: Partial<UserSettings>): Promise<{ ok: boolean; error: string | null }> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not authenticated" };

  try {
    const { env } = await import("@/lib/env");
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Server error (${res.status}): ${body}` };
    }

    // Update calendar MCP timezone if changed
    if (patch.timezone) {
      await mcpCallJsonSafe("ll5-calendar", "set_timezone", { timezone: patch.timezone });
    }

    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[profile] updateUserSettings failed:", msg);
    return { ok: false, error: msg };
  }
}

export async function logout(): Promise<void> {
  await clearToken();
  redirect("/login");
}
