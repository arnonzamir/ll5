"use server";

import { mcpCallJsonSafe } from "@/lib/api";

// --- Types ---

export interface Account {
  account_id: string;
  platform: string;
  display_name: string;
  status: string;
  last_seen_at?: string;
}

export interface Conversation {
  id: string;
  account_id: string;
  platform: string;
  conversation_id: string;
  name: string | null;
  is_group: boolean;
  permission: "agent" | "input" | "ignore";
  last_message_at: string | null;
}

// --- Server Actions ---

export async function fetchAccounts(): Promise<Account[]> {
  const raw = await mcpCallJsonSafe<Record<string, unknown>>(
    "messaging",
    "list_accounts"
  );
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as Account[];
  // Unwrap first array value
  for (const val of Object.values(raw)) {
    if (Array.isArray(val)) return val as Account[];
  }
  return [];
}

export async function fetchConversations(
  accountId?: string
): Promise<Conversation[]> {
  const args: Record<string, unknown> = { limit: 500 };
  if (accountId) args.account_id = accountId;

  const raw = await mcpCallJsonSafe<Record<string, unknown>>(
    "messaging",
    "list_conversations",
    args
  );
  if (!raw || typeof raw !== "object") return [];
  if (Array.isArray(raw)) return raw as Conversation[];
  for (const val of Object.values(raw)) {
    if (Array.isArray(val)) return val as Conversation[];
  }
  return [];
}

export async function updatePermission(
  platform: string,
  conversationId: string,
  permission: string
): Promise<boolean> {
  try {
    const result = await mcpCallJsonSafe<Record<string, unknown>>(
      "messaging",
      "update_conversation_permissions",
      { platform, conversation_id: conversationId, permission }
    );
    return result !== null;
  } catch (err) {
    console.error("[messaging] updatePermission failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function syncConversations(
  accountId: string
): Promise<{ total: number; new_conversations: number }> {
  try {
    const result = await mcpCallJsonSafe<{
      total: number;
      new_conversations: number;
    }>("messaging", "sync_whatsapp_conversations", {
      account_id: accountId,
    });
    return result ?? { total: 0, new_conversations: 0 };
  } catch (err) {
    console.error("[messaging] syncConversations failed:", err instanceof Error ? err.message : String(err));
    return { total: 0, new_conversations: 0 };
  }
}
