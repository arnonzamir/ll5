"use server";

import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";
import type { MeOnboarding, StepKey, OnboardingState } from "./onboarding-types";

/* ---------- gateway helpers ---------- */

async function gatewayGet(path: string): Promise<Record<string, unknown> | null> {
  const token = await getToken();
  if (!token) return null;
  try {
    const res = await fetch(`${env.GATEWAY_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error(`[onboarding] GET ${path} failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function gatewayPut(path: string, body: unknown): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;
  try {
    const res = await fetch(`${env.GATEWAY_URL}${path}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error(`[onboarding] PUT ${path} failed:`, res.status, await res.text().catch(() => ""));
    }
    return res.ok;
  } catch (err) {
    console.error(`[onboarding] PUT ${path} failed:`, err instanceof Error ? err.message : String(err));
    return false;
  }
}

/* ---------- live onboarding status (drives progress + verification) ---------- */

const EMPTY_ME: MeOnboarding = {
  onboarding: { completed: false, steps: {} },
  channels: { google: false, whatsapp: false, health: false },
  phone: { linked: false, device_count: 0 },
  profile: { display_name: null, timezone: null, work_week: null, self_names: null },
};

/**
 * Fetch the self-scoped GET /me/onboarding snapshot. Drives both the initial
 * resume (first incomplete step) and the live polling for phone/channel
 * verification. Returns empty defaults on any failure so the wizard still loads.
 */
export async function fetchMeOnboarding(): Promise<MeOnboarding> {
  const raw = await gatewayGet("/me/onboarding");
  if (!raw) return EMPTY_ME;
  const onboarding = (raw.onboarding ?? {}) as Partial<OnboardingState>;
  const channels = (raw.channels ?? {}) as Record<string, unknown>;
  const phone = (raw.phone ?? {}) as Record<string, unknown>;
  const profile = (raw.profile ?? {}) as Record<string, unknown>;
  return {
    onboarding: {
      completed: onboarding.completed === true,
      steps: (onboarding.steps ?? {}) as MeOnboarding["onboarding"]["steps"],
    },
    channels: {
      google: channels.google === true,
      whatsapp: channels.whatsapp === true,
      health: channels.health === true,
    },
    phone: {
      linked: phone.linked === true,
      device_count: Number(phone.device_count ?? 0),
    },
    profile: {
      display_name: (profile.display_name as string | null) ?? null,
      timezone: (profile.timezone as string | null) ?? null,
      work_week: profile.work_week ?? null,
      self_names: profile.self_names ?? null,
    },
  };
}

/* ---------- step completion (deep-merge PUT /user-settings) ---------- */

/** Read the current onboarding object so we can merge step-by-step without
 *  clobbering sibling keys (the gateway deep-merges, but we still preserve the
 *  full onboarding object shape on each write). */
async function currentOnboarding(): Promise<OnboardingState> {
  const settings = await gatewayGet("/user-settings");
  return (settings?.onboarding ?? { completed: false, steps: {} }) as OnboardingState;
}

/** Mark a single onboarding step done (or explicitly not-done). */
export async function setOnboardingStep(
  step: StepKey,
  done: boolean = true,
): Promise<{ ok: boolean }> {
  const current = await currentOnboarding();
  const ok = await gatewayPut("/user-settings", {
    onboarding: { ...current, steps: { ...current.steps, [step]: done } },
  });
  return { ok };
}

/** Mark the whole onboarding flow complete. */
export async function completeOnboarding(): Promise<{ ok: boolean }> {
  const current = await currentOnboarding();
  const ok = await gatewayPut("/user-settings", {
    onboarding: { ...current, completed: true },
  });
  return { ok };
}

/* ---------- Google connect (reuse onboarding popup/poll pattern) ---------- */

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

export async function checkGoogleConnection(): Promise<{ connected: boolean }> {
  const token = await getToken();
  if (!token) return { connected: false };
  try {
    const res = await fetch(`${env.MCP_CALENDAR_URL}/api/connection-status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { connected: false };
    const data = (await res.json()) as { connected: boolean };
    return { connected: data.connected === true };
  } catch (err) {
    console.error("[onboarding] checkGoogleConnection failed:", err instanceof Error ? err.message : String(err));
    return { connected: false };
  }
}
