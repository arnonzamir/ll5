"use server";

import { mcpCallList } from "@/lib/api";

/** Shape returned by the awareness MCP get_tracked_devices tool. */
export interface TrackedDevice {
  name: string;
  device_type: "phone" | "tablet" | "watch" | "tracker" | "unknown";
  place: string;
  matched_place: string | null;
  address: string | null;
  location: { lat: number; lon: number };
  accuracy_m: number | null;
  battery_pct: number | null;
  last_seen: string;
  age_minutes: number;
  freshness: "live" | "recent" | "stale" | "unknown";
  updated_at: string | null;
  since_update_minutes: number | null;
}

export async function fetchTrackedDevices(limit = 50): Promise<TrackedDevice[]> {
  return mcpCallList<TrackedDevice>("awareness", "get_tracked_devices", { limit });
}
