"use server";

import { esBase, esHeaders } from "@/lib/es";

// Follow one concern end to end (DECISION-012): given a correlation id, pull every
// app_log line + audit/tool_call row that shares it, across services, in time order.
export type TraceField = "request_id" | "session_id" | "trace_id";

export interface TraceEvent {
  source_index: "app_log" | "audit";
  _id: string;
  timestamp?: string;
  service?: string;
  level?: string;
  action?: string;
  message?: string;
  // audit
  kind?: string; // 'mutation' | 'tool_call'
  tool_name?: string;
  summary?: string;
  entity_type?: string;
  entity_id?: string;
  args?: string; // JSON string (tool_call)
  result?: string; // JSON string (tool_call)
  duration_ms?: number;
  success?: boolean;
  error_message?: string;
  // correlation
  request_id?: string;
  session_id?: string;
  trace_id?: string;
  user_id?: string;
}

async function queryIndex(index: string, field: TraceField, value: string, limit: number): Promise<TraceEvent[]> {
  try {
    const res = await fetch(`${esBase()}/${index}/_search`, {
      method: "POST",
      headers: esHeaders(),
      cache: "no-store",
      body: JSON.stringify({
        size: limit,
        sort: [{ timestamp: { order: "asc" } }],
        query: { bool: { filter: [{ term: { [field]: value } }] } },
      }),
    });
    if (!res.ok) return [];
    const j = (await res.json()) as { hits?: { hits?: Array<{ _id: string; _source: Record<string, unknown> }> } };
    return (j.hits?.hits ?? []).map((h) => ({ ...(h._source as object), _id: h._id })) as TraceEvent[];
  } catch {
    return [];
  }
}

export async function fetchTrace(
  field: TraceField,
  value: string,
  limit = 500,
): Promise<{ events: TraceEvent[]; counts: { app_log: number; audit: number } }> {
  const v = value.trim();
  if (!v) return { events: [], counts: { app_log: 0, audit: 0 } };
  const [appRows, auditRows] = await Promise.all([
    queryIndex("ll5_app_log", field, v, limit),
    queryIndex("ll5_audit_log", field, v, limit),
  ]);
  const events: TraceEvent[] = [
    ...appRows.map((r) => ({ ...r, source_index: "app_log" as const })),
    ...auditRows.map((r) => ({ ...r, source_index: "audit" as const })),
  ];
  events.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  return { events, counts: { app_log: appRows.length, audit: auditRows.length } };
}
