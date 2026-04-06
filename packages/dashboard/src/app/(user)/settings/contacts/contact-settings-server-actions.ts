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
  status?: string;
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

export interface ContactEntry {
  contactId: string;
  platform: string;
  platformId: string;
  displayName: string | null;
  phoneNumber: string | null;
  personId: string | null;
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

  let people: Array<{ id: string; name: string; relationship?: string; status?: string }> = [];
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

  // Build people list with linked platforms — only full KB people with at least one contact
  return people
    .filter((p) => !p.status || p.status === 'full')
    .map((p) => {
      const linked = contacts.filter((c) => c.person_id === p.id);
      return {
        id: p.id,
        name: p.name,
        relationship: p.relationship,
        status: p.status,
        platforms: linked.map((c) => ({ platform: c.platform, platform_id: c.platform_id, display_name: c.display_name })),
        settings: settingsMap.get(p.id),
      };
    })
    .filter((p) => p.platforms.length > 0);
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

export async function fetchContactsForTab(): Promise<ContactEntry[]> {
  const token = await getToken();
  if (!token) return [];

  // Fetch all non-group contacts, full people IDs (to exclude), and contact settings — in parallel
  let allContacts: Array<{ id: string; platform: string; platform_id: string; display_name: string | null; phone_number: string | null; person_id: string | null; is_group: boolean }> = [];
  const fullPersonIds = new Set<string>();

  const [contactsRaw, peopleRaw, { settings }] = await Promise.all([
    mcpCallJsonSafe<Record<string, unknown>>("ll5-messaging", "list_contacts", { is_group: false, limit: 1000 }),
    (async () => {
      try {
        const knowledgeUrl = "https://mcp-knowledge.noninoni.click";
        return await callMcpTool(knowledgeUrl, "list_people", { limit: 200 }, token);
      } catch { return null; }
    })(),
    fetchContactSettings({ target_type: "person" }),
  ]);

  // Parse contacts
  if (contactsRaw && typeof contactsRaw === "object") {
    for (const val of Object.values(contactsRaw)) {
      if (Array.isArray(val)) { allContacts = val as typeof allContacts; break; }
    }
  }

  // Parse people to get full person IDs
  if (peopleRaw) {
    const parsed = extractJson<Record<string, unknown>>(peopleRaw);
    if (parsed && typeof parsed === "object") {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          for (const p of val as Array<{ id: string; status?: string }>) {
            if (!p.status || p.status === "full") fullPersonIds.add(p.id);
          }
          break;
        }
      }
    }
  }

  const settingsMap = new Map(settings.map((s) => [s.target_id, s]));

  // Contacts tab: contacts NOT linked to a full person
  return allContacts
    .filter((c) => !c.is_group && (!c.person_id || !fullPersonIds.has(c.person_id)))
    .map((c) => ({
      contactId: c.id,
      platform: c.platform,
      platformId: c.platform_id,
      displayName: c.display_name,
      phoneNumber: c.phone_number,
      personId: c.person_id,
      settings: c.person_id ? settingsMap.get(c.person_id) : undefined,
    }))
    .sort((a, b) => (a.displayName ?? a.platformId).localeCompare(b.displayName ?? b.platformId));
}

export async function createStubAndSaveSetting(
  contactId: string,
  displayName: string,
  platform: string,
  field: string,
  value: unknown,
): Promise<string | null> {
  const token = await getToken();
  if (!token) return null;

  try {
    // 1. Create contact-only person in knowledge MCP
    const knowledgeUrl = "https://mcp-knowledge.noninoni.click";
    const result = await callMcpTool(knowledgeUrl, "upsert_person", {
      name: displayName,
      status: "contact-only",
    }, token);
    const parsed = extractJson<{ person: { id: string }; created: boolean }>(result);
    if (!parsed?.person?.id) return null;
    const personId = parsed.person.id;

    // 2. Link the contact to the new person
    await mcpCallJsonSafe("ll5-messaging", "link_contact_to_person", {
      contact_id: contactId,
      person_id: personId,
    });

    // 3. Save the contact setting
    await upsertContactSetting({
      target_type: "person",
      target_id: personId,
      [field]: value,
      display_name: displayName,
      platform,
    });

    return personId;
  } catch (err) {
    console.error("[contacts] createStubAndSaveSetting failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function promoteContact(personId: string, name: string): Promise<boolean> {
  const token = await getToken();
  if (!token) return false;

  try {
    const knowledgeUrl = "https://mcp-knowledge.noninoni.click";
    await callMcpTool(knowledgeUrl, "upsert_person", {
      id: personId,
      name,
      status: "full",
    }, token);
    return true;
  } catch (err) {
    console.error("[contacts] promoteContact failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}
