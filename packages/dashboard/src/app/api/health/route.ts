import { NextResponse } from "next/server";
import { getToken } from "@/lib/auth";

export async function GET() {
  const token = await getToken();
  return NextResponse.json({
    status: "ok",
    hasToken: !!token,
    tokenPrefix: token ? token.substring(0, 10) + "..." : null,
  });
}
