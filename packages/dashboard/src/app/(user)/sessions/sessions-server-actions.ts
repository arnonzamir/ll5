"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface SessionSummary {
  session_id: string;
  message_count: number;
  first_message: string;
  last_message: string;
  workspace: string;
  indexed_at: string;
}

export interface SessionDetail {
  session_id: string;
  message_count: number;
  first_message: string;
  last_message: string;
  messages: { role: string; text: string; timestamp: string }[];
}

async function gatewayFetch(path: string): Promise<Response> {
  const token = await getToken();
  if (!token) throw new Error("Not authenticated");
  return fetch(`${env.GATEWAY_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
}

export async function fetchSessions(
  limit = 20,
  offset = 0
): Promise<{ sessions: SessionSummary[]; total: number }> {
  try {
    const res = await gatewayFetch(
      `/sessions?limit=${limit}&offset=${offset}`
    );
    if (!res.ok) return { sessions: [], total: 0 };
    return (await res.json()) as { sessions: SessionSummary[]; total: number };
  } catch (err) {
    console.error("[sessions] fetchSessions failed:", err instanceof Error ? err.message : String(err));
    return { sessions: [], total: 0 };
  }
}

export async function fetchSession(
  id: string
): Promise<SessionDetail | null> {
  try {
    const res = await gatewayFetch(`/sessions/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as SessionDetail;
  } catch (err) {
    console.error("[sessions] fetchSession failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
