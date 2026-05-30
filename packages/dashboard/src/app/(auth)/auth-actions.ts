"use server";

import { redirect } from "next/navigation";
import { env } from "@/lib/env";
import { setToken } from "@/lib/auth";
import { validateNewPassword } from "@/lib/password";

/** Public, unauthenticated gateway POST helper for the auth flows. */
async function publicPost(
  path: string,
  body: Record<string, unknown>
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${env.GATEWAY_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    /* tolerate empty / non-JSON bodies */
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Forgot password. The gateway always returns 200 {ok:true} regardless of
 * whether the email exists (no account enumeration), so this never surfaces
 * a distinguishing error to the caller.
 */
export async function forgotPasswordAction(
  _prev: unknown,
  formData: FormData
): Promise<{ done: boolean; error?: string }> {
  const email = (formData.get("email") as string | null)?.trim();
  if (!email) {
    return { done: false, error: "Email is required" };
  }
  try {
    await publicPost("/auth/forgot", { email });
  } catch (err) {
    console.error(
      "[forgotPasswordAction] error:",
      err instanceof Error ? err.message : String(err)
    );
    // Still report "done" to avoid leaking gateway state / enabling enumeration.
  }
  return { done: true };
}

/** Reset password using an emailed token. */
export async function resetPasswordAction(
  _prev: unknown,
  formData: FormData
): Promise<{ error: string } | never> {
  const token = (formData.get("token") as string | null) ?? "";
  const password = (formData.get("password") as string | null) ?? "";
  const confirm = (formData.get("confirm") as string | null) ?? "";

  if (!token) return { error: "Reset link is missing or invalid." };
  const pwError = validateNewPassword(password, confirm);
  if (pwError) return { error: pwError };

  try {
    const { ok, data } = await publicPost("/auth/reset", { token, password });
    if (!ok) {
      return { error: (data.error as string) || "Reset failed. The link may have expired." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Reset failed." };
  }

  redirect("/login?flash=reset-success");
}

/** Accept an invite: create the account, store the returned session token. */
export async function acceptInviteAction(
  _prev: unknown,
  formData: FormData
): Promise<{ error: string } | never> {
  const token = (formData.get("token") as string | null) ?? "";
  const password = (formData.get("password") as string | null) ?? "";
  const confirm = (formData.get("confirm") as string | null) ?? "";
  const displayName = (formData.get("display_name") as string | null)?.trim() || undefined;
  const username = (formData.get("username") as string | null)?.trim() || undefined;

  if (!token) return { error: "Invite link is missing or invalid." };
  const pwError = validateNewPassword(password, confirm);
  if (pwError) return { error: pwError };

  let sessionToken: string;
  try {
    const { ok, status, data } = await publicPost("/invites/accept", {
      token,
      password,
      display_name: displayName,
      username,
    });
    if (!ok) {
      return {
        error:
          (data.error as string) ||
          (status === 400
            ? "This invite is invalid or has expired."
            : "Could not accept the invite."),
      };
    }
    sessionToken = data.token as string;
    if (!sessionToken) {
      return { error: "The server did not return a session. Please try logging in." };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Could not accept the invite." };
  }

  await setToken(sessionToken);
  redirect("/onboarding");
}
