"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import type { Tenant, MutationResult, InviteResult } from "./tenants-types";

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
