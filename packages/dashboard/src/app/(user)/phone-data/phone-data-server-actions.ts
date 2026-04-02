"use server";

import { env } from "@/lib/env";

export interface PhoneLocationItem {
  type: "location";
  timestamp: string;
  lat: number;
  lon: number;
  address?: string;
  matched_place?: string;
  accuracy?: number;
  battery_pct?: number;
}

export interface PhoneMessageItem {
  type: "message";
  timestamp: string;
  sender: string;
  app: string;
  content: string;
  is_group?: boolean;
  group_name?: string;
}

export interface PhoneCalendarItem {
  type: "calendar";
  timestamp: string;
  start_time: string;
  end_time: string;
  title: string;
  location?: string;
  source: string;
  calendar_name?: string;
}

export type PhoneDataItem =
  | PhoneLocationItem
  | PhoneMessageItem
  | PhoneCalendarItem;

export interface PhoneDataQuery {
  type?: "all" | "location" | "message" | "calendar";
  from?: string;
  to?: string;
  limit?: number;
}

interface ESHit<T> {
  _source: T;
}

interface ESResponse<T> {
  hits: {
    total: { value: number };
    hits: ESHit<T>[];
  };
}

function buildDateFilter(from?: string, to?: string): Record<string, unknown>[] {
  const filters: Record<string, unknown>[] = [];
  if (from || to) {
    const range: Record<string, string> = {};
    if (from) range.gte = from;
    if (to) range.lte = to;
    filters.push({ range: { timestamp: range } });
  }
  return filters;
}

async function queryIndex<T>(
  index: string,
  extraFilters: Record<string, unknown>[],
  limit: number,
  sortField = "timestamp"
): Promise<ESHit<T>[]> {
  const baseUrl = env.ELASTICSEARCH_URL;
  try {
    const response = await fetch(`${baseUrl}/${index}/_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: limit,
        sort: [{ [sortField]: { order: "desc" } }],
        query:
          extraFilters.length > 0
            ? { bool: { filter: extraFilters } }
            : { match_all: {} },
      }),
    });

    if (!response.ok) return [];

    const data = (await response.json()) as ESResponse<T>;
    return data.hits.hits;
  } catch (err) {
    console.error("[phone-data] ES query failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

interface RawLocation {
  timestamp: string;
  location?: { lat: number; lon: number };
  address?: string;
  matched_place?: string;
  accuracy?: number;
  battery_pct?: number;
}

interface RawMessage {
  timestamp: string;
  sender?: string;
  app?: string;
  content?: string;
  is_group?: boolean;
  group_name?: string;
}

interface RawCalendar {
  timestamp?: string;
  start_time: string;
  end_time: string;
  title?: string;
  location?: string;
  source?: string;
  calendar_name?: string;
}

export async function fetchPhoneData(
  params: PhoneDataQuery
): Promise<PhoneDataItem[]> {
  const queryType = params.type ?? "all";
  const limit = params.limit ?? 100;
  const dateFilters = buildDateFilter(params.from, params.to);

  const results: PhoneDataItem[] = [];

  const queries: Promise<void>[] = [];

  if (queryType === "all" || queryType === "location") {
    queries.push(
      queryIndex<RawLocation>(
        "ll5_awareness_locations",
        dateFilters,
        limit
      ).then((hits) => {
        for (const hit of hits) {
          const s = hit._source;
          results.push({
            type: "location",
            timestamp: s.timestamp,
            lat: s.location?.lat ?? 0,
            lon: s.location?.lon ?? 0,
            address: s.address,
            matched_place: s.matched_place,
            accuracy: s.accuracy,
            battery_pct: s.battery_pct,
          });
        }
      })
    );
  }

  if (queryType === "all" || queryType === "message") {
    queries.push(
      queryIndex<RawMessage>(
        "ll5_awareness_messages",
        dateFilters,
        limit
      ).then((hits) => {
        for (const hit of hits) {
          const s = hit._source;
          results.push({
            type: "message",
            timestamp: s.timestamp,
            sender: s.sender ?? "Unknown",
            app: s.app ?? "Unknown",
            content: s.content ?? "",
            is_group: s.is_group,
            group_name: s.group_name,
          });
        }
      })
    );
  }

  if (queryType === "all" || queryType === "calendar") {
    const calFilters = [
      ...dateFilters,
      {
        terms: { source: ["phone", "merged"] },
      },
    ];
    queries.push(
      queryIndex<RawCalendar>(
        "ll5_awareness_calendar_events",
        calFilters,
        limit,
        "start_time"
      ).then((hits) => {
        for (const hit of hits) {
          const s = hit._source;
          results.push({
            type: "calendar",
            timestamp: s.start_time,
            start_time: s.start_time,
            end_time: s.end_time,
            title: s.title ?? "Untitled",
            location: s.location,
            source: s.source ?? "phone",
            calendar_name: s.calendar_name,
          });
        }
      })
    );
  }

  await Promise.all(queries);

  results.sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return results.slice(0, limit);
}
