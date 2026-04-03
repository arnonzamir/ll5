"use server";

import { env } from "@/lib/env";
import { getToken } from "@/lib/auth";

export interface JournalEntry {
  id: string;
  type: string;
  topic: string;
  content: string;
  signal: string | null;
  status: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface JournalFilters {
  type?: string;
  status?: string;
  topic?: string;
  since?: string;
  limit?: number;
}

export async function fetchJournalEntries(
  filters: JournalFilters = {}
): Promise<{ entries: JournalEntry[]; total: number }> {
  const token = await getToken();
  if (!token) return { entries: [], total: 0 };

  const params = new URLSearchParams();
  if (filters.type) params.set("type", filters.type);
  if (filters.status) params.set("status", filters.status);
  if (filters.topic) params.set("topic", filters.topic);
  if (filters.since) params.set("since", filters.since);
  if (filters.limit) params.set("limit", String(filters.limit));

  const qs = params.toString();
  const url = `${env.GATEWAY_URL}/journal${qs ? `?${qs}` : ""}`;

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return { entries: [], total: 0 };
    return (await response.json()) as { entries: JournalEntry[]; total: number };
  } catch (err) {
    console.error("[journal] fetchJournalEntries failed:", err instanceof Error ? err.message : String(err));
    return { entries: [], total: 0 };
  }
}

export interface UserModelSection {
  id: string;
  section: string;
  content: Record<string, unknown>;
  last_updated: string;
}

export async function fetchUserModel(): Promise<UserModelSection[]> {
  const token = await getToken();
  if (!token) return [];

  try {
    const response = await fetch(`${env.GATEWAY_URL}/user-model`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];
    const data = (await response.json()) as { sections: UserModelSection[] };
    return data.sections;
  } catch (err) {
    console.error("[journal] fetchUserModel failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function resolveEntry(
  id: string
): Promise<{ updated: boolean }> {
  const token = await getToken();
  if (!token) return { updated: false };

  try {
    const response = await fetch(`${env.GATEWAY_URL}/journal/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ status: "resolved" }),
    });
    if (!response.ok) return { updated: false };
    return (await response.json()) as { updated: boolean };
  } catch (err) {
    console.error("[journal] resolveEntry failed:", err instanceof Error ? err.message : String(err));
    return { updated: false };
  }
}
