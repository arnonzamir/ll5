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
  } catch {
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
  } catch {
    return { success: false, name };
  }
}

export async function logout(): Promise<void> {
  await clearToken();
  redirect("/login");
}
