"use server";

import { env } from "@/lib/env";
import { getToken, decodeTokenPayload } from "@/lib/auth";

// --- Types ---

export interface User {
  id: string;
  username: string | null;
  display_name: string | null;
  role: string;
  enabled: boolean;
  timezone: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Family {
  id: string;
  name: string;
  created_at: string;
  members: FamilyMember[];
}

export interface FamilyMember {
  user_id: string;
  username: string | null;
  display_name: string | null;
  role: string; // parent | child | member
}

interface TokenInfo {
  sub?: string;
  user_id?: string;
  name?: string;
  role?: string;
  exp?: number;
  iat?: number;
}

// --- Helpers ---

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

// --- Token info ---

export async function getCurrentUserInfo(): Promise<TokenInfo | null> {
  const token = await getToken();
  if (!token) return null;
  return decodeTokenPayload(token) as TokenInfo | null;
}

// --- User actions ---

export async function fetchUsers(): Promise<User[]> {
  try {
    const res = await adminFetch("/admin/users");
    if (!res || !res.ok) return [];
    return (await res.json()) as User[];
  } catch (err) {
    console.error("[fetchUsers] error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchUser(id: string): Promise<User | null> {
  try {
    const res = await adminFetch(`/admin/users/${id}`);
    if (!res || !res.ok) return null;
    return (await res.json()) as User;
  } catch (err) {
    console.error("[fetchUser] error:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function createUser(data: {
  username: string;
  display_name?: string;
  pin: string;
  role?: string;
  timezone?: string;
}): Promise<{ success: boolean; user?: User; error?: string }> {
  try {
    const res = await adminFetch("/admin/users", {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to create user");
      return { success: false, error: text };
    }
    const user = (await res.json()) as User;
    return { success: true, user };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateUser(
  id: string,
  data: { username?: string; display_name?: string; role?: string; timezone?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to update user");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resetPin(
  id: string,
  pin: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/users/${id}/pin`, {
      method: "POST",
      body: JSON.stringify({ pin }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to reset PIN");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function disableUser(
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/users/${id}`, {
      method: "DELETE",
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to disable user");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function enableUser(
  id: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to enable user");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Family actions ---

export async function fetchFamilies(): Promise<Family[]> {
  try {
    const res = await adminFetch("/admin/families");
    if (!res || !res.ok) return [];
    return (await res.json()) as Family[];
  } catch (err) {
    console.error("[fetchFamilies] error:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function createFamily(
  name: string
): Promise<{ success: boolean; family?: Family; error?: string }> {
  try {
    const res = await adminFetch("/admin/families", {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to create family");
      return { success: false, error: text };
    }
    const family = (await res.json()) as Family;
    return { success: true, family };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function addFamilyMember(
  familyId: string,
  userId: string,
  role: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/families/${familyId}/members`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId, role }),
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to add member");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeFamilyMember(
  familyId: string,
  userId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await adminFetch(`/admin/families/${familyId}/members/${userId}`, {
      method: "DELETE",
    });
    if (!res) return { success: false, error: "Not authenticated" };
    if (!res.ok) {
      const text = await res.text().catch(() => "Failed to remove member");
      return { success: false, error: text };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
