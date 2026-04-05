"use server";

import { env } from "@/lib/env";
import { mcpCallJsonSafe } from "@/lib/api";

export interface LogEntry {
  timestamp: string;
  // App log fields
  service: string;
  level: string;
  action: string;
  message: string;
  user_id?: string;
  tool_name?: string;
  duration_ms?: number;
  success?: boolean;
  error_message?: string;
  metadata?: Record<string, unknown>;
  // Audit log fields (different schema)
  source?: string;
  summary?: string;
  entity_type?: string;
  entity_id?: string;
}

export interface LogQuery {
  index?: "app" | "audit";
  service?: string;
  level?: string;
  action?: string;
  tool_name?: string;
  query?: string;
  from?: string;
  limit?: number;
}

export async function fetchLogs(params: LogQuery): Promise<{
  logs: LogEntry[];
  total: number;
}> {
  const baseUrl = env.ELASTICSEARCH_URL;
  const index =
    params.index === "audit" ? "ll5_audit_log" : "ll5_app_log";
  const limit = params.limit ?? 100;

  const filters: Record<string, unknown>[] = [];

  if (params.service) {
    // Audit log uses 'source', app log uses 'service'
    if (params.index === "audit") {
      filters.push({ term: { source: params.service } });
    } else {
      filters.push({ term: { service: params.service } });
    }
  }
  if (params.level) {
    filters.push({ term: { level: params.level } });
  }
  if (params.action) {
    filters.push({ term: { action: params.action } });
  }
  if (params.tool_name) {
    filters.push({ term: { tool_name: params.tool_name } });
  }
  if (params.from) {
    filters.push({ range: { timestamp: { gte: params.from } } });
  }

  const must: Record<string, unknown>[] = [];
  if (params.query) {
    must.push({
      multi_match: {
        query: params.query,
        fields: ["message", "summary", "error_message", "tool_name", "entity_type"],
      },
    });
  }

  try {
    const response = await fetch(`${baseUrl}/${index}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: limit,
        sort: [{ timestamp: { order: "desc" } }],
        query: {
          bool: {
            ...(filters.length > 0 ? { filter: filters } : {}),
            ...(must.length > 0 ? { must } : {}),
          },
        },
      }),
    });

    if (!response.ok) {
      return { logs: [], total: 0 };
    }

    const data = (await response.json()) as {
      hits: {
        total: { value: number };
        hits: Array<{ _source: LogEntry }>;
      };
    };

    return {
      logs: data.hits.hits.map((h) => h._source),
      total: data.hits.total.value,
    };
  } catch (err) {
    console.error("[logs] fetchLogs failed:", err instanceof Error ? err.message : String(err));
    return { logs: [], total: 0 };
  }
}

/**
 * Fetch entity details by type and ID for the audit log tooltip.
 */
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
