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

export async function fetchLocations(params: {
  from?: string;
  to?: string;
  limit?: number;
}): Promise<LocationPoint[]> {
  return mcpCallList<LocationPoint>("awareness", "query_location_history", params);
}

export async function fetchCurrentLocation(): Promise<LocationPoint | null> {
  try {
    return await mcpCallJsonSafe<LocationPoint>("awareness", "get_current_location");
  } catch {
    return null;
  }
}
