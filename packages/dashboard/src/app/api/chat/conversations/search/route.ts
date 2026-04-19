import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

export async function GET(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const res = await fetch(
    `${env.GATEWAY_URL}/chat/conversations/search${url.search}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
