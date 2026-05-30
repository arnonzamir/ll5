"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import type { Tenant, MutationResult, InviteResult } from "./tenants-types";
import {
  parseRuntime,
  type AgentRuntime,
} from "@/app/(user)/settings/agent/agent-types";

/** Admin-authenticated gateway call (bearer = current session token). */
async function adminFetch(path: string, options?: RequestInit) {
  const token = await getToken();
  if (!token) return null;
  return fetch(`${env.GATEWAY_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
}

/** GET /admin/tenants — superadmin-gated on the gateway. */
export async function fetchTenants(): Promise<Tenant[]> {
  try {
    const res = await adminFetch("/admin/tenants");
    if (!res || !res.ok) return [];
    const data = (await res.json()) as { tenants?: Tenant[] } | Tenant[];
    return Array.isArray(data) ? data : data.tenants ?? [];
  } catch (err) {
    console.error(
      "[fetchTenants] error:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

/** PATCH /admin/users/:id { enabled } — enable/disable a tenant. */
export async function setTenantEnabled(
  userId: string,
  enabled: boolean
): Promise<MutationResult> {
  try {
    const res = await adminFetch(`/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res
        .text()
        .catch(() => "Failed to update tenant status");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ---------- Per-tenant hosted runtime (superadmin) ---------- */

export interface RuntimeActionResult {
  success: boolean;
  runtime?: AgentRuntime;
  error?: string;
}

function unwrapRuntime(raw: unknown): AgentRuntime {
  const body = (raw ?? {}) as Record<string, unknown>;
  return parseRuntime("runtime" in body ? body.runtime : body);
}

/**
 * POST /admin/tenants/:id/agent/provision — provision a tenant's hosted agent.
 * 400 => tenant has no Claude key; 404 => unknown tenant; 503 => runtime not
 * configured (no agent host yet). Superadmin-gated on the gateway.
 */
export async function provisionTenantRuntime(
  userId: string
): Promise<RuntimeActionResult> {
  try {
    const res = await adminFetch(
      `/admin/tenants/${encodeURIComponent(userId)}/agent/provision`,
      { method: "POST" }
    );
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      if (res.status === 400) {
        return { success: false, error: "Tenant has no Claude API key configured." };
      }
      if (res.status === 404) {
        return { success: false, error: "Tenant not found." };
      }
      if (res.status === 503) {
        return { success: false, error: "Agent runtime is not configured yet." };
      }
      return { success: false, error: `Provision failed (${res.status}).` };
    }
    return { success: true, runtime: unwrapRuntime(await res.json()) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** POST /admin/tenants/:id/agent/stop — stop a tenant's hosted agent. 503 => not configured. */
export async function stopTenantRuntime(
  userId: string
): Promise<RuntimeActionResult> {
  try {
    const res = await adminFetch(
      `/admin/tenants/${encodeURIComponent(userId)}/agent/stop`,
      { method: "POST" }
    );
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      if (res.status === 503) {
        return { success: false, error: "Agent runtime is not configured yet." };
      }
      return { success: false, error: `Stop failed (${res.status}).` };
    }
    return { success: true, runtime: unwrapRuntime(await res.json()) };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** POST /admin/invites { email, role? } — invite/resend; returns accept_url. */
export async function inviteTenant(
  email: string,
  role?: string
): Promise<InviteResult> {
  try {
    const res = await adminFetch("/admin/invites", {
      method: "POST",
      body: JSON.stringify(role ? { email, role } : { email }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to send invite");
      return { success: false, error: text };
    }
    const body = (await res.json()) as { accept_url?: string };
    return { success: true, accept_url: body.accept_url };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
