"use server";

import { mcpCall, mcpCallJson, mcpCallList } from "@/lib/api";

export interface KnowledgeResult {
  entity_type: string;
  entity_id: string;
  score: number;
  highlight?: string;
  summary?: string;
  data?: Record<string, unknown>;
}

export interface Fact {
  id: string;
  type?: string;
  category?: string;
  content: string;
  provenance?: string;
  confidence?: number;
  tags?: string[];
}

interface SearchResponse {
  results: KnowledgeResult[];
  total: number;
}

export async function searchKnowledge(
  query: string
): Promise<KnowledgeResult[]> {
  try {
    const raw = await mcpCallJson<SearchResponse>("knowledge", "search_knowledge", {
      query,
      limit: 20,
    });
    return raw.results ?? [];
  } catch (err) {
    console.error("[knowledge] searchKnowledge failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchRecentFacts(): Promise<Fact[]> {
  return mcpCallList<Fact>("knowledge", "list_facts", { limit: 20 });
}

export async function upsertFact(
  data: Omit<Fact, "id"> & { id?: string }
): Promise<void> {
  await mcpCall("knowledge", "upsert_fact", data as Record<string, unknown>);
}

export async function deleteFact(id: string): Promise<void> {
  await mcpCall("knowledge", "delete_fact", { id });
}
