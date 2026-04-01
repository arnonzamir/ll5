import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

export async function POST(req: NextRequest) {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const formData = await req.formData();
  const res = await fetch(`${env.GATEWAY_URL}/chat/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
