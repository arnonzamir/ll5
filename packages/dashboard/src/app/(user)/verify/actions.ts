"use server";

import { redirect } from "next/navigation";
import { loginWithPassword } from "@/lib/auth";
import { safeNextPath } from "@/lib/sensitive";
import { sessionUserId, setStepUpCookie } from "@/lib/step-up";

/**
 * Identity re-validation for sensitive pages. Checks the password against the
 * gateway (`POST /auth/token`, same path as login) but does NOT replace the
 * session cookie: the only effect of success is the short-lived `ll5_stepup`
 * cookie. The gateway's `user_id` in the reply must equal the session's uid,
 * so confirming with a different account's credentials never unlocks anything.
 */
export async function verifyIdentityAction(formData: FormData): Promise<{ error: string } | never> {
  const next = safeNextPath(formData.get("next") as string | null);
  const email = ((formData.get("email") as string | null) ?? "").trim();
  const password = (formData.get("password") as string | null) ?? "";
  if (!email || !password) return { error: "Email and password are required" };

  const uid = await sessionUserId();
  if (!uid) redirect(`/login?next=${encodeURIComponent(next)}`);

  let confirmedUserId: string | undefined;
  try {
    const res = await loginWithPassword(email, password);
    confirmedUserId = res.user_id;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Verification failed" };
  }

  if (!confirmedUserId || confirmedUserId !== uid) {
    console.warn("[verify] password confirmed for a different account than the session", { session: uid });
    return { error: "Those credentials belong to a different account than the one signed in." };
  }

  const set = await setStepUpCookie(uid);
  if (!set.ok) return { error: set.error };
  redirect(next);
}
