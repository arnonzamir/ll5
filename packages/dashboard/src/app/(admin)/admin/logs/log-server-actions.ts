"use server";

import { env } from "@/lib/env";

export interface LogEntry {
  timestamp: string;
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
    filters.push({ term: { service: params.service } });
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
        fields: ["message", "error_message", "tool_name"],
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
