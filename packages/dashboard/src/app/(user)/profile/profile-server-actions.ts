"use server";

import { redirect } from "next/navigation";
import { getToken, clearToken, decodeTokenPayload } from "@/lib/auth";

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

export async function logout(): Promise<void> {
  await clearToken();
  redirect("/login");
}
