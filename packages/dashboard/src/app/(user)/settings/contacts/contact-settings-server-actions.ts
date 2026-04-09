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
  platforms: Array<{ contactId: string; platform: string; platform_id: string; display_name: string }>;
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
  let contacts: Array<{ id: string; platform_id: string; platform: string; display_name: string; person_id?: string }> = [];

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
        platforms: linked.map((c) => ({ contactId: c.id, platform: c.platform, platform_id: c.platform_id, display_name: c.display_name })),
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

export async function searchPeopleForLink(query: string): Promise<Array<{ id: string; name: string; relationship?: string }>> {
  const token = await getToken();
  if (!token) return [];

  try {
    const knowledgeUrl = "https://mcp-knowledge.noninoni.click";
    const result = await callMcpTool(knowledgeUrl, "list_people", { query, status: "full", limit: 20 }, token);
    const parsed = extractJson<Record<string, unknown>>(result);
    if (parsed && typeof parsed === "object") {
      for (const val of Object.values(parsed)) {
        if (Array.isArray(val)) {
          return (val as Array<{ id: string; name: string; relationship?: string }>).map((p) => ({
            id: p.id,
            name: p.name,
            relationship: p.relationship,
          }));
        }
      }
    }
    return [];
  } catch (err) {
    console.error("[contacts] searchPeopleForLink failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function linkContactToPerson(contactId: string, personId: string): Promise<boolean> {
  try {
    await mcpCallJsonSafe("ll5-messaging", "link_contact_to_person", {
      contact_id: contactId,
      person_id: personId,
    });
    return true;
  } catch (err) {
    console.error("[contacts] linkContactToPerson failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export async function unlinkContactFromPerson(contactId: string): Promise<boolean> {
  try {
    await mcpCallJsonSafe("ll5-messaging", "unlink_contact_from_person", {
      contact_id: contactId,
    });
    return true;
  } catch (err) {
    console.error("[contacts] unlinkContactFromPerson failed:", err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface MatchSuggestion {
  contactId: string;
  contactName: string;
  contactPlatformId: string;
  platform: string;
  suggestions: Array<{ personId: string; personName: string; relationship?: string; notes?: string }>;
}

/**
 * Simple name similarity: normalize and compare.
 * Returns a score 0-1 where 1 is exact match.
 */
function nameSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]/g, " ").trim();
  const nb = b.toLowerCase().replace(/[^a-z0-9\u0590-\u05ff]/g, " ").trim();
  if (na === nb) return 1;
  // Check if one contains the other (e.g. "Dima" matches "Dima Petrov")
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  // Check first name match (first word)
  const fa = na.split(/\s+/)[0];
  const fb = nb.split(/\s+/)[0];
  if (fa && fb && fa === fb && fa.length >= 3) return 0.6;
  return 0;
}

function isRealName(name: string): boolean {
  if (!name) return false;
  if (/^[\d+\s()-]+$/.test(name)) return false;
  if (name.includes("@s.whatsapp.net") || name.includes("@lid") || name.includes("@g.us")) return false;
  return true;
}

export async function fetchMatchSuggestions(): Promise<MatchSuggestion[]> {
  const token = await getToken();
  if (!token) return [];

  try {
    const knowledgeUrl = "https://mcp-knowledge.noninoni.click";

    // Step 1: Fetch all people and all unlinked named contacts in parallel
    const [peopleResult, contactsRaw] = await Promise.all([
      callMcpTool(knowledgeUrl, "list_people", { limit: 200 }, token),
      mcpCallJsonSafe<Record<string, unknown>>("ll5-messaging", "auto_match_contacts", { limit: 500 }),
    ]);

    // Parse people
    let allPeople: Array<{ id: string; name: string; aliases?: string[]; relationship?: string; notes?: string }> = [];
    const parsedPeople = extractJson<Record<string, unknown>>(peopleResult);
    if (parsedPeople && typeof parsedPeople === "object") {
      for (const val of Object.values(parsedPeople)) {
        if (Array.isArray(val)) { allPeople = val as typeof allPeople; break; }
      }
    }

    // Parse unlinked contacts
    let unlinkedContacts: Array<{ contact_id: string; contact_name: string; contact_platform: string; contact_platform_id: string }> = [];
    if (contactsRaw && typeof contactsRaw === "object") {
      for (const val of Object.values(contactsRaw)) {
        if (Array.isArray(val)) { unlinkedContacts = val as typeof unlinkedContacts; break; }
      }
    }

    // Filter contacts to real names only
    const namedContacts = unlinkedContacts.filter((c) => isRealName(c.contact_name));

    // Step 2: Get IDs of people who already have linked contacts
    const linkedContactsRaw = await mcpCallJsonSafe<Record<string, unknown>>("ll5-messaging", "list_contacts", { linked_only: true, limit: 500 });
    const linkedPersonIds = new Set<string>();
    if (linkedContactsRaw && typeof linkedContactsRaw === "object") {
      for (const val of Object.values(linkedContactsRaw)) {
        if (Array.isArray(val)) {
          for (const c of val as Array<{ person_id?: string }>) {
            if (c.person_id) linkedPersonIds.add(c.person_id);
          }
          break;
        }
      }
    }

    // Step 3: For each unlinked person, find matching contacts by name similarity
    const unlinkedPeople = allPeople.filter((p) => !linkedPersonIds.has(p.id));
    const results: MatchSuggestion[] = [];
    const claimedContactIds = new Set<string>();

    for (const person of unlinkedPeople) {
      const names = [person.name, ...(person.aliases ?? [])];
      const matches: Array<{ contact: typeof namedContacts[0]; score: number }> = [];

      for (const contact of namedContacts) {
        if (claimedContactIds.has(contact.contact_id)) continue;
        const bestScore = Math.max(...names.map((n) => nameSimilarity(n, contact.contact_name)));
        if (bestScore >= 0.6) {
          matches.push({ contact, score: bestScore });
        }
      }

      // Sort by score descending, take top 3
      matches.sort((a, b) => b.score - a.score);
      const topMatches = matches.slice(0, 3);

      if (topMatches.length > 0) {
        // Present as: this contact should link to this person
        // Use the best match as the primary suggestion
        const best = topMatches[0];
        results.push({
          contactId: best.contact.contact_id,
          contactName: best.contact.contact_name,
          contactPlatformId: best.contact.contact_platform_id,
          platform: best.contact.contact_platform,
          suggestions: [{
            personId: person.id,
            personName: person.name,
            relationship: person.relationship,
            notes: person.notes,
          }],
        });
        claimedContactIds.add(best.contact.contact_id);
      }
    }

    return results;
  } catch (err) {
    console.error("[contacts] fetchMatchSuggestions failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
