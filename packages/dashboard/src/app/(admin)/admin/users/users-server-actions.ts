"use server";

import { getToken, decodeTokenPayload } from "@/lib/auth";

interface TokenInfo {
  sub?: string;
  user_id?: string;
  name?: string;
  role?: string;
  exp?: number;
  iat?: number;
}

export async function getCurrentUserInfo(): Promise<TokenInfo | null> {
  const token = await getToken();
  if (!token) return null;
  return decodeTokenPayload(token) as TokenInfo | null;
}
