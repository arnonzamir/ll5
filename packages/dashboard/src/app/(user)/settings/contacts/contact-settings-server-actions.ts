"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";
import { mcpCallJsonSafe } from "@/lib/api";
import { callMcpTool, extractJson } from "@/lib/mcp-client";

export interface ContactSetting {
  id: string;
  target_type: "person" | "group";
  target_id: string;
  routing: string;
  permission: string;
  download_media: boolean;
  display_name: string | null;
  platform: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonWithPlatforms {
  id: string;
  name: string;
  relationship?: string;
  platforms: Array<{ platform: string; platform_id: string; display_name: string }>;
  settings?: ContactSetting;
}

export interface GroupWithSettings {
  conversation_id: string;
  name: string | null;
  platform: string;
  is_archived: boolean;
  settings?: ContactSetting;
}

export async function fetchContactSettings(params?: {
  target_type?: string;
  search?: string;
}): Promise<{ settings: ContactSetting[]; total: number }> {
  const token = await getToken();
  if (!token) return { settings: [], total: 0 };

  try {
    const sp = new URLSearchParams();
    if (params?.target_type) sp.set("target_type", params.target_type);
    if (params?.search) sp.set("search", params.search);
    sp.set("limit", "500");

    const res = await fetch(`${env.GATEWAY_URL}/contact-settings?${sp}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { settings: [], total: 0 };
    return (await res.json()) as { settings: ContactSetting[]; total: number };
  } catch (err) {
    console.error("[contacts] fetchContactSettings failed:", err instanceof Error ? err.message : String(err));
    return { settings: [], total: 0 };
  }
}

export async function upsertContactSetting(data: {
  target_type: string;
  target_id: string;
  routing?: string;
  permission?: string;
  download_media?: boolean;
  display_name?: string;
  platform?: string;
}): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const res = await fetch(`${env.GATEWAY_URL}/contact-settings`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function deleteContactSetting(id: string): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const res = await fetch(`${env.GATEWAY_URL}/contact-settings/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchPeopleWithPlatforms(): Promise<PersonWithPlatforms[]> {
  const token = await getToken();
  if (!token) return [];

  let people: Array<{ id: string; name: string; relationship?: string }> = [];
  let contacts: Array<{ platform_id: string; platform: string; display_name: string; person_id?: string }> = [];

  // Get people from knowledge MCP — call directly to avoid internal URL issues
  try {
    const knowledgeUrl = "https://mcp-knowledge.noninoni.click";
    const result = await callMcpTool(knowledgeUrl, "list_people", { limit: 200 }, token);
    const parsed = extractJson<Record<string, unknown>>(result);
    if (parsed && typeof parsed === "object") {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          people = val as typeof people;
          break;
        }
      }
    }
    console.log("[contacts] People found:", people.length);
  } catch (err) {
    console.error("[contacts] Failed to fetch people:", err instanceof Error ? err.message : String(err));
  }

  // Get contacts from messaging MCP
  try {
    const raw = await mcpCallJsonSafe<Record<string, unknown>>("ll5-messaging", "list_contacts", { limit: 1000 });
    if (raw && typeof raw === "object") {
      for (const val of Object.values(raw)) {
        if (Array.isArray(val)) {
          contacts = val as typeof contacts;
          break;
        }
      }
    }
  } catch (err) {
    console.error("[contacts] Failed to fetch contacts:", err instanceof Error ? err.message : String(err));
  }

  // Get current contact settings
  const { settings } = await fetchContactSettings({ target_type: "person" });
  const settingsMap = new Map(settings.map((s) => [s.target_id, s]));

  // Build people list with linked platforms
  return people.map((p) => {
    const linked = contacts.filter((c) => c.person_id === p.id);
    return {
      id: p.id,
      name: p.name,
      relationship: p.relationship,
      platforms: linked.map((c) => ({ platform: c.platform, platform_id: c.platform_id, display_name: c.display_name })),
      settings: settingsMap.get(p.id),
    };
  });
}

export async function fetchGroupsWithSettings(): Promise<GroupWithSettings[]> {
  // Get conversations from messaging MCP
  let conversations: Array<{ conversation_id: string; name: string | null; platform: string; is_group: boolean; is_archived: boolean }> = [];
  try {
    const raw = await mcpCallJsonSafe<Record<string, unknown>>("ll5-messaging", "list_conversations", { is_group: true, limit: 500 });
    if (raw && typeof raw === "object") {
      for (const val of Object.values(raw)) {
        if (Array.isArray(val)) {
          conversations = val as typeof conversations;
          break;
        }
      }
    }
  } catch (err) {
    console.error("[contacts] Failed to fetch conversations:", err instanceof Error ? err.message : String(err));
  }

  // Get current contact settings for groups
  const { settings } = await fetchContactSettings({ target_type: "group" });
  const settingsMap = new Map(settings.map((s) => [s.target_id, s]));

  return conversations.map((c) => ({
    conversation_id: c.conversation_id,
    name: c.name,
    platform: c.platform,
    is_archived: c.is_archived ?? false,
    settings: settingsMap.get(c.conversation_id),
  }));
}
