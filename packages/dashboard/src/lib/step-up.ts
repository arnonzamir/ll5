/**
 * Server-side step-up helpers (server components + server actions only —
 * imports next/headers). The pure cookie maths lives in sensitive.ts.
 */
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { decodeTokenPayload, getToken } from "./auth";
import {
  STEP_UP_COOKIE,
  STEP_UP_TTL_SECONDS,
  VERIFY_PATH,
  isStepUpValid,
  signStepUp,
  userIdFromPayload,
} from "./sensitive";

function authSecret(): string | null {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    // Surfaced, never silent: without the secret no step-up can be minted or
    // verified, so every sensitive page bounces to /verify, which then shows
    // this same problem as an error.
    console.error("[step-up] AUTH_SECRET is not set; sensitive pages cannot be unlocked");
    return null;
  }
  return s;
}

/** The current session's user id, or null when there is no session. */
export async function sessionUserId(): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;
  return userIdFromPayload(decodeTokenPayload(token));
}

/** True when the request carries a valid step-up cookie for the session user. */
export async function hasStepUp(): Promise<boolean> {
  const [uid, store] = await Promise.all([sessionUserId(), cookies()]);
  const secret = authSecret();
  if (!uid || !secret) return false;
  return isStepUpValid(store.get(STEP_UP_COOKIE)?.value, uid, secret, Math.floor(Date.now() / 1000));
}

/**
 * Gate for every server action / page behind a sensitive path: returns the
 * user id when the step-up cookie is valid, otherwise throws Next's redirect
 * to /verify?next=<nextPath> (a missing session goes to /login as usual).
 */
export async function requireStepUp(nextPath: string): Promise<string> {
  const uid = await sessionUserId();
  if (!uid) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (!(await hasStepUp())) redirect(`${VERIFY_PATH}?next=${encodeURIComponent(nextPath)}`);
  return uid;
}

/** Mint the step-up cookie for the session user (called only after a successful password check). */
export async function setStepUpCookie(userId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const secret = authSecret();
  if (!secret) return { ok: false, error: "Server is missing AUTH_SECRET; identity confirmation is unavailable." };
  const exp = Math.floor(Date.now() / 1000) + STEP_UP_TTL_SECONDS;
  const value = await signStepUp(userId, exp, secret);
  const store = await cookies();
  store.set(STEP_UP_COOKIE, value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: STEP_UP_TTL_SECONDS,
  });
  return { ok: true };
}

export async function clearStepUpCookie(): Promise<void> {
  const store = await cookies();
  store.delete(STEP_UP_COOKIE);
}
