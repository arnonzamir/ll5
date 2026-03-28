import { NextRequest, NextResponse } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const token = await getToken();
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const body = await req.json();
  const gatewayUrl = `${env.GATEWAY_URL}/chat/messages/${id}`;

  const res = await fetch(gatewayUrl, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return NextResponse.json(data, { status: res.status });
}
