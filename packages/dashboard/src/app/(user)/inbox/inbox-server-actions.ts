"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

interface InboxEntry {
  id: string;
  title: string;
  source?: string | null;
  captured_at?: string | null;
}

export async function fetchInbox(): Promise<InboxEntry[]> {
  return mcpCallList<InboxEntry>("gtd", "list_inbox");
}

export async function captureInbox(text: string): Promise<void> {
  await mcpCall("gtd", "capture_inbox", { text, source: "dashboard" });
}
