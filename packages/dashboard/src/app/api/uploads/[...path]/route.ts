import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

const COOKIE_NAME = "ll5_token";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token) return new NextResponse(null, { status: 401 });

  const { path } = await params;
  const filePath = path.join("/");
  const res = await fetch(`${env.GATEWAY_URL}/uploads/${filePath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return new NextResponse(null, { status: res.status });

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
