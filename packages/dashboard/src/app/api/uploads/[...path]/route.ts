import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;
  const filePath = path.join("/");
  const res = await fetch(`${env.GATEWAY_URL}/uploads/${filePath}`);
  if (!res.ok) return new NextResponse(null, { status: res.status });

  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const body = await res.arrayBuffer();
  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
