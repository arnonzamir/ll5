import { cookies } from "next/headers";
import { env } from "./env";

const COOKIE_NAME = "ll5_token";

export async function getToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value ?? null;
}

export async function setToken(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
}

export async function clearToken(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function login(
  loginId: string,
  pin: string
): Promise<{ token: string }> {
  // loginId can be a UUID (user_id) or a username — gateway accepts both
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(loginId);
  const body = isUuid ? { user_id: loginId, pin } : { username: loginId, pin };
  const res = await fetch(`${env.GATEWAY_URL}/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "Login failed");
    throw new Error(text);
  }
  return res.json() as Promise<{ token: string }>;
}

/** Decode the JWT payload without verification (for display purposes only). */
export function decodeTokenPayload(
  token: string
): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
    return JSON.parse(payload) as Record<string, unknown>;
  } catch (err) {
    console.error("[decodeTokenPayload] Failed to decode token:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
