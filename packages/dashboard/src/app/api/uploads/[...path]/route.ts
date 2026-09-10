import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

const COOKIE_NAME = "ll5_token";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // `/public/*` on the gateway is the unauthenticated, crypto-random-name route
  // (shareable links). Everything else is per-file ownership-gated.
  const isPublic = path[0] === "public";
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (!token && !isPublic) return new NextResponse(null, { status: 401 });

  const upstream = isPublic
    ? `${env.GATEWAY_URL}/public/${path.slice(1).join("/")}`
    : `${env.GATEWAY_URL}/uploads/${path.join("/")}`;

  const res = await fetch(upstream, {
    headers: isPublic ? {} : { Authorization: `Bearer ${token}` },
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
