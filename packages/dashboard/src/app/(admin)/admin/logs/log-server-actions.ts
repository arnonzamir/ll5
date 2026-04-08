"use server";

import { env } from "@/lib/env";
import { mcpCallJsonSafe } from "@/lib/api";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface LogQuery {
  index: string;                          // 'll5_app_log' | 'll5_audit_log'
  search?: string;                        // free text
  timeRange: string;                      // '15m' | '1h' | '4h' | '1d' | '7d'
  filters: Record<string, string[]>;      // { level: ['error','warn'], service: ['gtd'] }
  facetFields: string[];                  // ['level', 'service', 'action', 'tool_name']
  sortField?: string;                     // default: 'timestamp'
  sortOrder?: "asc" | "desc";            // default: 'desc'
  limit?: number;                         // default: 100
  offset?: number;                        // for pagination
}

export interface LogResult {
  logs: Array<{ _id: string; _source: Record<string, unknown> }>;
  total: number;
  facets: Record<string, Array<{ key: string; count: number }>>;
}

/* ------------------------------------------------------------------ */
/*  fetchLogs — main query with aggregations                           */
/* ------------------------------------------------------------------ */

export async function fetchLogs(params: LogQuery): Promise<LogResult> {
  const baseUrl = env.ELASTICSEARCH_URL;
  const index = params.index;
  const limit = params.limit ?? 100;
  const offset = params.offset ?? 0;
  const sortField = params.sortField ?? "timestamp";
  const sortOrder = params.sortOrder ?? "desc";

  // Time range filter
  const timeRangeMap: Record<string, string> = {
    "15m": "now-15m",
    "1h": "now-1h",
    "4h": "now-4h",
    "1d": "now-1d",
    "7d": "now-7d",
  };
  const gte = timeRangeMap[params.timeRange] ?? "now-1h";

  const filters: Record<string, unknown>[] = [
    { range: { timestamp: { gte } } },
  ];

  // Facet filters
  for (const [field, values] of Object.entries(params.filters)) {
    if (values.length > 0) {
      filters.push({ terms: { [field]: values } });
    }
  }

  // Free text search
  const must: Record<string, unknown>[] = [];
  if (params.search) {
    must.push({
      multi_match: {
        query: params.search,
        fields: ["message", "summary", "error_message", "tool_name", "entity_type"],
        type: "phrase_prefix",
      },
    });
  }

  // Aggregations for facets
  const aggs: Record<string, unknown> = {};
  for (const field of params.facetFields) {
    aggs[field] = { terms: { field, size: 30 } };
  }

  try {
    const response = await fetch(`${baseUrl}/${index}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: limit,
        from: offset,
        sort: [{ [sortField]: { order: sortOrder } }],
        query: {
          bool: {
            filter: filters,
            ...(must.length > 0 ? { must } : {}),
          },
        },
        aggs,
      }),
    });

    if (!response.ok) {
      console.error("[logs] ES error:", response.status, await response.text().catch(() => ""));
      return { logs: [], total: 0, facets: {} };
    }

    const data = (await response.json()) as {
      hits: {
        total: { value: number };
        hits: Array<{ _id: string; _source: Record<string, unknown> }>;
      };
      aggregations?: Record<string, { buckets: Array<{ key: string; doc_count: number }> }>;
    };

    // Parse facets from aggregations
    const facets: Record<string, Array<{ key: string; count: number }>> = {};
    if (data.aggregations) {
      for (const [field, agg] of Object.entries(data.aggregations)) {
        facets[field] = agg.buckets.map((b) => ({
          key: b.key,
          count: b.doc_count,
        }));
      }
    }

    return {
      logs: data.hits.hits.map((h) => ({ _id: h._id, _source: h._source })),
      total: data.hits.total.value,
      facets,
    };
  } catch (err) {
    console.error("[logs] fetchLogs failed:", err instanceof Error ? err.message : String(err));
    return { logs: [], total: 0, facets: {} };
  }
}

/* ------------------------------------------------------------------ */
/*  fetchLogById — single document for detail panel                    */
/* ------------------------------------------------------------------ */

export async function fetchLogById(
  index: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const baseUrl = env.ELASTICSEARCH_URL;

  try {
    const response = await fetch(`${baseUrl}/${index}/_doc/${id}`, {
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) return null;

    const data = (await response.json()) as {
      _id: string;
      _source: Record<string, unknown>;
    };
    return { _id: data._id, ...data._source };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  fetchEntityDetails — audit log entity tooltips                     */
/* ------------------------------------------------------------------ */

export async function fetchEntityDetails(
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown> | null> {
  // Map entity types to MCP tools
  const lookups: Record<string, { server: "knowledge" | "gtd" | "ll5-calendar" | "awareness"; tool: string; args: Record<string, string> }> = {
    fact: { server: "knowledge", tool: "list_facts", args: { query: entityId } },
    person: { server: "knowledge", tool: "list_people", args: { query: entityId } },
    place: { server: "knowledge", tool: "get_place", args: { id: entityId } },
    action: { server: "gtd", tool: "list_actions", args: { query: entityId } },
    project: { server: "gtd", tool: "list_projects", args: { query: entityId } },
    event: { server: "ll5-calendar", tool: "list_events", args: {} },
    tickler: { server: "ll5-calendar", tool: "list_ticklers", args: {} },
  };

  // Direct ES lookup as fallback
  const esLookup: Record<string, string> = {
    fact: "ll5_knowledge_facts",
    person: "ll5_knowledge_people",
    place: "ll5_knowledge_places",
    action: "ll5_knowledge_facts", // actions are in PG, not ES — skip
    journal: "ll5_agent_journal",
    shopping_item: "ll5_knowledge_facts",
  };

  // Try direct ES lookup first (fastest)
  const index = esLookup[entityType];
  if (index && entityType !== "action") {
    try {
      const baseUrl = env.ELASTICSEARCH_URL;
      const res = await fetch(`${baseUrl}/${index}/_doc/${entityId}`, {
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        const data = await res.json() as { _source: Record<string, unknown> };
        return data._source ?? null;
      }
    } catch {
      // Fall through to MCP lookup
    }
  }

  // Try MCP lookup
  const lookup = lookups[entityType];
  if (lookup) {
    try {
      const result = await mcpCallJsonSafe<Record<string, unknown>>(lookup.server, lookup.tool, lookup.args);
      return result;
    } catch {
      return null;
    }
  }

  return null;
}
