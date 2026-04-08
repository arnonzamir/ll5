"use server";

import { getToken } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";
import { env } from "@/lib/env";

/* ---------- types ---------- */

export interface OnboardingSteps {
  profile_set: boolean;
  timezone_configured: boolean;
  google_connected: boolean;
  android_installed: boolean;
}

export interface OnboardingState {
  completed: boolean;
  steps: OnboardingSteps;
}

export interface OnboardingData {
  onboarding: OnboardingState;
  displayName: string;
  timezone: string;
  googleConnected: boolean;
}

/* ---------- helpers ---------- */

async function gatewayGet(path: string, token: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function gatewayPut(path: string, body: unknown, token: string): Promise<boolean> {
  try {
    const res = await fetch(`${env.GATEWAY_URL}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ---------- fetch onboarding state ---------- */

export async function fetchOnboardingState(): Promise<OnboardingData> {
  const defaults: OnboardingData = {
    onboarding: {
      completed: false,
      steps: {
        profile_set: false,
        timezone_configured: false,
        google_connected: false,
        android_installed: false,
      },
    },
    displayName: "",
    timezone: "",
    googleConnected: false,
  };

  const token = await getToken();
  if (!token) return defaults;

  // Fetch user settings, profile, and Google connection status in parallel
  const [settings, profileData, googleStatus] = await Promise.all([
    gatewayGet("/user-settings", token),
    mcpCallJsonSafe<{ profile: { name?: string; display_name?: string } | null }>(
      "knowledge",
      "get_profile"
    ),
    fetchGoogleConnectionStatusInternal(token),
  ]);

  // Extract onboarding state from settings
  const raw = (settings?.onboarding ?? {}) as Record<string, unknown>;
  const steps = (raw.steps ?? {}) as Record<string, boolean>;

  // Check actual status from live data
  const profileName = profileData?.profile?.name ?? profileData?.profile?.display_name ?? "";
  const hasProfile = profileName.length > 0;
  const timezone = (settings?.timezone as string) ?? "";
  const hasTimezone = timezone.length > 0;
  const googleConnected = googleStatus;

  return {
    onboarding: {
      completed: raw.completed === true,
      steps: {
        profile_set: steps.profile_set === true || hasProfile,
        timezone_configured: steps.timezone_configured === true || hasTimezone,
        google_connected: steps.google_connected === true || googleConnected,
        android_installed: steps.android_installed === true,
      },
    },
    displayName: profileName,
    timezone,
    googleConnected,
  };
}

async function fetchGoogleConnectionStatusInternal(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${env.MCP_CALENDAR_URL}/api/connection-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { connected: boolean };
    return data.connected === true;
  } catch {
    return false;
  }
}

/* ---------- complete a single step ---------- */

export async function completeOnboardingStep(
  step: keyof OnboardingSteps
): Promise<{ ok: boolean }> {
  const token = await getToken();
  if (!token) return { ok: false };

  // Read current settings first
  const settings = await gatewayGet("/user-settings", token);
  const currentOnboarding = (settings?.onboarding ?? { completed: false, steps: {} }) as OnboardingState;
  const updatedSteps = { ...currentOnboarding.steps, [step]: true };

  const ok = await gatewayPut(
    "/user-settings",
    { onboarding: { ...currentOnboarding, steps: updatedSteps } },
    token
  );
  return { ok };
}

/* ---------- mark onboarding complete ---------- */

export async function completeOnboarding(): Promise<{ ok: boolean }> {
  const token = await getToken();
  if (!token) return { ok: false };

  const settings = await gatewayGet("/user-settings", token);
  const currentOnboarding = (settings?.onboarding ?? { completed: false, steps: {} }) as OnboardingState;

  const ok = await gatewayPut(
    "/user-settings",
    { onboarding: { ...currentOnboarding, completed: true } },
    token
  );
  return { ok };
}

/* ---------- update timezone ---------- */

export async function updateTimezone(tz: string): Promise<{ ok: boolean }> {
  const token = await getToken();
  if (!token) return { ok: false };

  // Update gateway user_settings with timezone
  const ok = await gatewayPut("/user-settings", { timezone: tz }, token);

  // Also update calendar MCP timezone
  if (ok) {
    await mcpCallJsonSafe("ll5-calendar", "set_timezone", { timezone: tz });
  }

  return { ok };
}

/* ---------- update display name ---------- */

export async function updateDisplayName(
  name: string
): Promise<{ ok: boolean; name: string }> {
  try {
    const data = await mcpCallJsonSafe<{ profile: { name?: string } }>(
      "knowledge",
      "update_profile",
      { name }
    );
    return { ok: true, name: data?.profile?.name ?? name };
  } catch (err) {
    console.error("[onboarding] updateDisplayName failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, name };
  }
}

/* ---------- get Google auth URL ---------- */

export async function getGoogleAuthUrl(): Promise<{ auth_url: string | null; error: string | null }> {
  const token = await getToken();
  if (!token) return { auth_url: null, error: "Not authenticated" };

  try {
    const res = await fetch(`${env.MCP_CALENDAR_URL}/api/auth-url`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { auth_url: null, error: `Server error (${res.status}): ${body}` };
    }
    const data = (await res.json()) as { auth_url: string };
    return { auth_url: data.auth_url, error: null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[onboarding] getGoogleAuthUrl failed:", msg);
    return { auth_url: null, error: msg };
  }
}

/* ---------- check Google connection ---------- */

export async function checkGoogleConnection(): Promise<{ connected: boolean }> {
  const token = await getToken();
  if (!token) return { connected: false };
  return { connected: await fetchGoogleConnectionStatusInternal(token) };
}
