"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import type {
  Invite,
  CreateInviteResult,
  MutationResult,
} from "./invites-types";

/** Admin-authenticated gateway call (bearer = current admin session token). */
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

export async function fetchInvites(): Promise<Invite[]> {
  try {
    const res = await adminFetch("/admin/invites");
    if (!res || !res.ok) return [];
    const data = (await res.json()) as { invites?: Invite[] } | Invite[];
    return Array.isArray(data) ? data : data.invites ?? [];
  } catch (err) {
    console.error(
      "[fetchInvites] error:",
      err instanceof Error ? err.message : String(err)
    );
    return [];
  }
}

export async function createInvite(data: {
  email: string;
  role?: string;
}): Promise<CreateInviteResult> {
  try {
    const res = await adminFetch("/admin/invites", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to create invite");
      return { success: false, error: text };
    }
    const body = (await res.json()) as {
      invite?: Invite;
      accept_url?: string;
    };
    return {
      success: true,
      invite: body.invite,
      accept_url: body.accept_url,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function revokeInvite(id: string): Promise<MutationResult> {
  try {
    const res = await adminFetch(`/admin/invites/${id}`, { method: "DELETE" });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to revoke invite");
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
