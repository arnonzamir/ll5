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

export async function fetchPeople(): Promise<Person[]> {
  return mcpCallList<Person>("knowledge", "list_people");
}

export async function upsertPerson(
  data: Omit<Person, "id"> & { id?: string }
): Promise<void> {
  await mcpCall("knowledge", "upsert_person", data as Record<string, unknown>);
}

export async function deletePerson(id: string): Promise<void> {
  await mcpCall("knowledge", "delete_person", { id });
}
