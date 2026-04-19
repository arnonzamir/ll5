import { NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

export async function GET() {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const res = await fetch(`${env.GATEWAY_URL}/chat/conversations/active`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
