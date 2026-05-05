"use server";

import { mcpCall, mcpCallJson, mcpCallList } from "@/lib/api";

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
  if (filters.offset) args.offset = filters.offset;
  return mcpCallList<Narrative>("knowledge", "list_narratives", args);
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
