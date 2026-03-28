"use server";

import { mcpCall, mcpCallJsonSafe } from "@/lib/api";

interface InboxEntry {
  id: string;
  title: string;
  source?: string | null;
  captured_at?: string | null;
}

export async function fetchInbox(): Promise<InboxEntry[]> {
  const result = await mcpCallJsonSafe<InboxEntry[]>("gtd", "list_inbox");
  return result ?? [];
}

export async function captureInbox(text: string): Promise<void> {
  await mcpCall("gtd", "capture_inbox", { text, source: "dashboard" });
}
