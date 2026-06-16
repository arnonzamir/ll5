import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

// Proxy active system-health alerts from the gateway (drives the banner).
export async function GET(_req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ alerts: [] }, { status: 200 });

  try {
    const res = await fetch(`${env.GATEWAY_URL}/alerts`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch {
    return NextResponse.json({ alerts: [] }, { status: 200 });
  }
}
