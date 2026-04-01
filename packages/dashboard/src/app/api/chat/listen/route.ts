import { NextRequest } from "next/server";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

/**
 * SSE proxy: forwards the gateway's /chat/listen SSE stream to the client.
 * This avoids CORS issues and keeps the auth token server-side.
 */
export async function GET(req: NextRequest) {
  const token = await getToken();
  if (!token) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
    });
  }

  const gatewayUrl = `${env.GATEWAY_URL}/chat/listen`;

  const upstream = await fetch(gatewayUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "text/event-stream",
    },
    signal: req.signal,
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("Gateway SSE connection failed", {
      status: upstream.status,
    });
  }

  // Stream the SSE response through
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
