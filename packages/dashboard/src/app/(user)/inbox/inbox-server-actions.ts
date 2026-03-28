"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

interface InboxEntry {
  id: string;
  title: string;
  content?: string;
  source?: string | null;
  captured_at?: string | null;
}

export async function fetchInbox(): Promise<InboxEntry[]> {
  return mcpCallList<InboxEntry>("gtd", "list_inbox");
}

export async function captureInbox(text: string): Promise<void> {
  await mcpCall("gtd", "capture_inbox", { text, source: "dashboard" });
}

export async function processInboxItem(
  id: string,
  outcomeType: string,
  fields?: Record<string, unknown>
): Promise<void> {
  await mcpCall("gtd", "process_inbox_item", {
    inbox_id: id,
    outcome_type: outcomeType,
    ...fields,
  });
}
