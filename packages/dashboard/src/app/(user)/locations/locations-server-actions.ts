"use server";

import { mcpCallList, mcpCallJsonSafe } from "@/lib/api";

export interface LocationPoint {
  id: string;
  location: { lat: number; lon: number };
  address?: string;
  matched_place?: string;
  matched_place_id?: string;
  accuracy?: number;
  speed?: number;
  timestamp: string;
}

/** Shape returned by the awareness MCP get_current_location tool */
interface CurrentLocationResponse {
  location: {
    lat: number;
    lon: number;
    accuracy?: number;
    timestamp?: string;
    freshness?: string;
    place_name?: string | null;
    place_type?: string | null;
    address?: string | null;
  };
}

/** Shape returned by the awareness MCP query_location_history tool */
interface HistoryLocationEntry {
  lat: number;
  lon: number;
  accuracy?: number;
  timestamp: string;
  place_name?: string | null;
  address?: string | null;
}

export async function fetchLocations(params: {
  from?: string;
  to?: string;
  limit?: number;
}): Promise<LocationPoint[]> {
  const raw = await mcpCallList<HistoryLocationEntry>("awareness", "query_location_history", params);
  return raw.map((entry) => ({
    id: `${entry.lat}-${entry.lon}-${entry.timestamp}`,
    location: { lat: entry.lat, lon: entry.lon },
    address: entry.address ?? undefined,
    matched_place: entry.place_name ?? undefined,
    accuracy: entry.accuracy,
    timestamp: entry.timestamp,
  }));
}

export async function fetchCurrentLocation(): Promise<LocationPoint | null> {
  try {
    const data = await mcpCallJsonSafe<CurrentLocationResponse>("awareness", "get_current_location");
    if (!data?.location) return null;

    const loc = data.location;
    return {
      id: "current",
      location: { lat: loc.lat, lon: loc.lon },
      address: loc.address ?? undefined,
      matched_place: loc.place_name ?? undefined,
      accuracy: loc.accuracy,
      timestamp: loc.timestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error("[locations] fetchCurrentLocation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
