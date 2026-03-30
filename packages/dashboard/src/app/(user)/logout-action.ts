"use server";

import { redirect } from "next/navigation";
import { clearToken } from "@/lib/auth";

export async function logoutAction(): Promise<never> {
  await clearToken();
  redirect("/login");
}
