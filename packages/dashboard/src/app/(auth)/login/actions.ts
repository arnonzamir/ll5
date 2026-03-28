"use server";

import { redirect } from "next/navigation";
import { login, setToken } from "@/lib/auth";

export async function loginAction(
  formData: FormData
): Promise<{ error: string } | never> {
  const userId = formData.get("user_id") as string;
  const pin = formData.get("pin") as string;

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

  redirect("/dashboard");
}
