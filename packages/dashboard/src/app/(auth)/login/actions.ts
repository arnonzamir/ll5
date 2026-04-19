"use server";

import { redirect } from "next/navigation";
import { login, setToken } from "@/lib/auth";

/** Only allow same-origin paths to prevent open-redirect. */
function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/dashboard";
  return raw;
}

export async function loginAction(
  formData: FormData
): Promise<{ error: string } | never> {
  const userId = formData.get("user_id") as string;
  const pin = formData.get("pin") as string;
  const next = safeNext(formData.get("next") as string | null);

  if (!userId || !pin) {
    return { error: "User ID and PIN are required" };
  }

  try {
    const { token } = await login(userId, pin);
    await setToken(token);
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Login failed",
    };
  }

  redirect(next);
}
