"use server";

import { mcpCall, mcpCallList } from "@/lib/api";

export interface Person {
  id: string;
  name: string;
  aliases?: string[];
  relationship?: string;
  contact_info?: {
    phone?: string;
    email?: string;
  };
  notes?: string;
  tags?: string[];
}

export async function fetchPeople(query?: string): Promise<Person[]> {
  const args: Record<string, unknown> = { limit: 200 };
  if (query?.trim()) args.query = query.trim();
  return mcpCallList<Person>("knowledge", "list_people", args);
}

export async function upsertPerson(
  data: Omit<Person, "id"> & { id?: string }
): Promise<void> {
  await mcpCall("knowledge", "upsert_person", data as Record<string, unknown>);
}

export async function deletePerson(id: string): Promise<void> {
  await mcpCall("knowledge", "delete_person", { id });
}
