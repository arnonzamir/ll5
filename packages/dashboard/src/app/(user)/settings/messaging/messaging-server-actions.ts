"use server";

import { mcpCallJsonSafe } from "@/lib/api";
import type {
  Account,
  Conversation,
  PairingQr,
  ProvisionResult,
  AccountStatus,
} from "./messaging-types";

// --- Server Actions ---

export async function fetchAccounts(): Promise<Account[]> {
  const raw = await mcpCallJsonSafe<Record<string, unknown>>(
    "ll5-messaging",
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
    "ll5-messaging",
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
      "ll5-messaging",
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
    }>("ll5-messaging", "sync_whatsapp_conversations", {
      account_id: accountId,
    });
    return result ?? { total: 0, new_conversations: 0 };
  } catch (err) {
    console.error("[messaging] syncConversations failed:", err instanceof Error ? err.message : String(err));
    return { total: 0, new_conversations: 0 };
  }
}

/**
 * Get live connection state for a single account (calls Evolution / Telegram
 * for a real-time check, not just the DB row).
 */
export async function getAccountStatus(accountId: string): Promise<AccountStatus | null> {
  try {
    const result = await mcpCallJsonSafe<AccountStatus>(
      "ll5-messaging",
      "get_account_status",
      { account_id: accountId },
    );
    return result ?? null;
  } catch (err) {
    console.error("[messaging] getAccountStatus failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Create a brand-new Evolution instance + DB row. Returns the initial QR
 * code so the UI can render it for pairing.
 */
export async function provisionWhatsAppAccount(
  instanceName: string,
): Promise<ProvisionResult> {
  try {
    const result = await mcpCallJsonSafe<ProvisionResult>(
      "ll5-messaging",
      "provision_whatsapp_account",
      { instance_name: instanceName },
    );
    return result ?? { success: false, error: "NO_RESPONSE" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[messaging] provisionWhatsAppAccount failed:", message);
    return { success: false, error: "PROVISION_FAILED", message };
  }
}

/**
 * Fetch a fresh QR code for an existing account (re-pair flow).
 */
export async function getPairingQr(accountId: string): Promise<PairingQr | null> {
  try {
    const result = await mcpCallJsonSafe<{ qr: PairingQr }>(
      "ll5-messaging",
      "get_pairing_qr",
      { account_id: accountId },
    );
    return result?.qr ?? null;
  } catch (err) {
    console.error("[messaging] getPairingQr failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Restart the Evolution instance to recover ghost-connected state. Wraps the
 * existing restart_whatsapp_account MCP tool.
 */
export async function restartAccount(accountId: string): Promise<{ success: boolean; state_after?: string; error?: string }> {
  try {
    const result = await mcpCallJsonSafe<{ state_after?: string; error?: string }>(
      "ll5-messaging",
      "restart_whatsapp_account",
      { account_id: accountId },
    );
    if (!result) return { success: false, error: "NO_RESPONSE" };
    if (result.error) return { success: false, error: result.error };
    return { success: true, state_after: result.state_after };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[messaging] restartAccount failed:", message);
    return { success: false, error: message };
  }
}

/**
 * Log the WhatsApp account out (without deleting the instance or DB row).
 */
export async function disconnectAccount(
  accountId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const result = await mcpCallJsonSafe<{ success?: boolean; error?: string }>(
      "ll5-messaging",
      "disconnect_whatsapp_account",
      { account_id: accountId },
    );
    if (!result) return { success: false, error: "NO_RESPONSE" };
    if (result.error) return { success: false, error: result.error };
    return { success: !!result.success };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[messaging] disconnectAccount failed:", message);
    return { success: false, error: message };
  }
}
