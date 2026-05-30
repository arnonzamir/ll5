"use server";

import { redirect } from "next/navigation";
import { login, loginWithPassword, setToken } from "@/lib/auth";

/** Only allow same-origin paths to prevent open-redirect. */
function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export async function loginAction(
  formData: FormData
): Promise<{ error: string } | never> {
  const mode = (formData.get("mode") as string | null) ?? "email";
  const next = safeNext(formData.get("next") as string | null);

  let token: string;

  if (mode === "pin") {
    const userId = formData.get("user_id") as string;
    const pin = formData.get("pin") as string;
    if (!userId || !pin) {
      return { error: "User ID and PIN are required" };
    }
    try {
      ({ token } = await login(userId, pin));
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Login failed" };
    }
  } else {
    const email = formData.get("email") as string;
    const password = formData.get("password") as string;
    if (!email || !password) {
      return { error: "Email and password are required" };
    }
    try {
      ({ token } = await loginWithPassword(email, password));
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Login failed" };
    }
  }

  await setToken(token);
  redirect(next);
}
