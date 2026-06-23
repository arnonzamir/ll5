"use server";

import { mcpCall, mcpCallJson, mcpCallList } from "@/lib/api";
import { getToken } from "@/lib/auth";
import { env } from "@/lib/env";

export type SubjectKind = "person" | "place" | "group" | "topic";

export interface SubjectRef {
  kind: SubjectKind;
  ref: string;
}

export interface NarrativeDecision {
  observedAt: string;
  text: string;
}

export interface Narrative {
  id: string;
  userId: string;
  subject: SubjectRef;
  title: string;
  summary: string;
  currentMood?: string;
  openThreads: string[];
  recentDecisions: NarrativeDecision[];
  participants: string[];
  places: string[];
  observationCount: number;
  firstObservedAt?: string;
  lastObservedAt?: string;
  lastConsolidatedAt?: string;
  sensitive: boolean;
  status: "active" | "dormant" | "closed";
  closedReason?: string;
}

export interface Observation {
  id: string;
  userId: string;
  subjects: SubjectRef[];
  text: string;
  source: string;
  sourceId?: string;
  sourceExcerpt?: string;
  confidence: "high" | "medium" | "low";
  mood?: string;
  sensitive: boolean;
  observedAt: string;
  createdAt: string;
}

export interface ListNarrativesFilters {
  status?: "active" | "dormant" | "closed";
  subject_kind?: SubjectKind;
  participant_id?: string;
  stale_for_days?: number;
  query?: string;
  sort?: "relevance" | "recency";
  limit?: number;
  offset?: number;
}

export async function fetchNarratives(filters: ListNarrativesFilters = {}): Promise<Narrative[]> {
  const args: Record<string, unknown> = { limit: filters.limit ?? 100 };
  if (filters.status) args.status = filters.status;
  if (filters.subject_kind) args.subject_kind = filters.subject_kind;
  if (filters.participant_id) args.participant_id = filters.participant_id;
  if (filters.stale_for_days) args.stale_for_days = filters.stale_for_days;
  if (filters.query?.trim()) args.query = filters.query.trim();
  if (filters.sort) args.sort = filters.sort;
  if (filters.offset) args.offset = filters.offset;
  return mcpCallList<Narrative>("knowledge", "list_narratives", args);
}

export type ConnectionVia = "shared-participant" | "shared-place" | "co-subject";

export interface EntityNode {
  kind: "person" | "place";
  ref: string;
  name?: string;
}

export interface RelatedNarrative {
  subject: SubjectRef;
  title: string;
  status: "active" | "dormant" | "closed";
  via: ConnectionVia[];
  weight: number;
  sharedKeys: string[];
}

export interface NarrativeConnections {
  subject: SubjectRef;
  entities: EntityNode[];
  related: RelatedNarrative[];
}

/** The connection map for one narrative — entity spokes + related narratives. */
export async function fetchNarrativeConnections(subject: SubjectRef): Promise<NarrativeConnections> {
  const result = await mcpCallJson<NarrativeConnections>("knowledge", "get_narrative_connections", { subject });
  return result ?? { subject, entities: [], related: [] };
}

/**
 * Fire an EPHEMERAL point-in-time agent summary (gateway POST /narratives/summarize).
 * The agent replies it into the chat thread; the stored narrative is NOT mutated.
 * Returns the event_id so the caller can correlate the assistant reply over the
 * chat SSE stream.
 */
export async function requestNarrativeSummary(
  subject: SubjectRef,
): Promise<{ event_id?: string; message_id?: string | null; error?: string }> {
  const token = await getToken();
  if (!token) return { error: "Not authenticated." };
  try {
    const res = await fetch(`${env.GATEWAY_URL}/narratives/summarize`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: subject.kind, ref: subject.ref }),
    });
    if (!res.ok) return { error: `Summary request failed (HTTP ${res.status}).` };
    return await res.json();
  } catch {
    return { error: "Couldn't reach the agent." };
  }
}

export async function fetchNarrativeDetail(
  subject: SubjectRef,
  observationLimit = 100,
): Promise<{ narrative: Narrative | null; observations: Observation[] }> {
  const result = await mcpCallJson<{ narrative: Narrative | null; observations: Observation[] }>(
    "knowledge",
    "get_narrative",
    { subject, observation_limit: observationLimit },
  );
  return {
    narrative: result?.narrative ?? null,
    observations: result?.observations ?? [],
  };
}

export async function closeNarrative(subject: SubjectRef, reason: string): Promise<void> {
  if (!reason?.trim()) {
    throw new Error("closed_reason is required");
  }
  await mcpCall("knowledge", "upsert_narrative", {
    subject,
    status: "closed",
    closed_reason: reason.trim(),
  });
}

export async function reopenNarrative(subject: SubjectRef): Promise<void> {
  await mcpCall("knowledge", "upsert_narrative", {
    subject,
    status: "active",
  });
}

export async function setDormant(subject: SubjectRef): Promise<void> {
  await mcpCall("knowledge", "upsert_narrative", {
    subject,
    status: "dormant",
  });
}
