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

export async function getTimezone(): Promise<{ timezone: string; error: string | null }> {
  const token = await getToken();
  if (!token) return { timezone: "Asia/Jerusalem", error: "Not authenticated" };

  try {
    const { env } = await import("@/lib/env");
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { timezone: "Asia/Jerusalem", error: `Server error (${res.status})` };
    const settings = (await res.json()) as Record<string, unknown>;
    return { timezone: (settings.timezone as string) ?? "Asia/Jerusalem", error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[profile] getTimezone failed:", msg);
    return { timezone: "Asia/Jerusalem", error: msg };
  }
}

export async function updateTimezone(timezone: string): Promise<{ ok: boolean; error: string | null }> {
  const token = await getToken();
  if (!token) return { ok: false, error: "Not authenticated" };

  try {
    const { env } = await import("@/lib/env");
    const res = await fetch(`${env.GATEWAY_URL}/user-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ timezone }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, error: `Server error (${res.status}): ${body}` };
    }

    // Also update calendar MCP so it picks up immediately
    await mcpCallJsonSafe("calendar", "set_timezone", { timezone });

    return { ok: true, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[profile] updateTimezone failed:", msg);
    return { ok: false, error: msg };
  }
}

export async function logout(): Promise<void> {
  await clearToken();
  redirect("/login");
}
