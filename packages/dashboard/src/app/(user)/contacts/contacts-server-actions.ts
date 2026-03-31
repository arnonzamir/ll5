"use server";

import { mcpCallJsonSafe, mcpCallList } from "@/lib/api";

// --- Types ---

export interface Contact {
  id: string;
  platform: string;
  platform_id: string;
  display_name: string | null;
  phone_number: string | null;
  is_group: boolean;
  person_id: string | null;
  last_seen_at: string | null;
}

export interface Person {
  id: string;
  name: string;
  aliases?: string[];
  relationship?: string;
}

// --- Server Actions ---

export async function fetchContacts(params?: {
  platform?: string;
  query?: string;
  linkedOnly?: boolean;
}): Promise<Contact[]> {
  const args: Record<string, unknown> = {};
  if (params?.platform) args.platform = params.platform;
  if (params?.query) args.query = params.query;
  if (params?.linkedOnly !== undefined) args.linked_only = params.linkedOnly;
  args.limit = 500;

  return mcpCallList<Contact>("messaging", "list_contacts", args);
}

export async function fetchPeople(): Promise<Person[]> {
  return mcpCallList<Person>("knowledge", "list_people");
}

export async function linkContactToPerson(
  contactId: string,
  personId: string
): Promise<boolean> {
  try {
    const result = await mcpCallJsonSafe<Record<string, unknown>>(
      "messaging",
      "link_contact_to_person",
      { contact_id: contactId, person_id: personId }
    );
    return result !== null;
  } catch {
    return false;
  }
}

export async function unlinkContact(contactId: string): Promise<boolean> {
  try {
    const result = await mcpCallJsonSafe<Record<string, unknown>>(
      "messaging",
      "unlink_contact_from_person",
      { contact_id: contactId }
    );
    return result !== null;
  } catch {
    return false;
  }
}
