import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

// Proxy chat messages to gateway
export async function GET(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const gatewayUrl = `${env.GATEWAY_URL}/chat/messages${url.search}`;

  const res = await fetch(gatewayUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}

export async function POST(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const gatewayUrl = `${env.GATEWAY_URL}/chat/messages`;

  const res = await fetch(gatewayUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
