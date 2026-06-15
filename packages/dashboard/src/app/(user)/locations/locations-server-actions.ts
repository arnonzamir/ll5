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
  /** Only set on the current-location snapshot: "stationary" | "moving" | ... */
  motion?: string | null;
  timestamp: string;
}

export interface CurrentWifi {
  connected: boolean;
  ssid: string | null;
  bssid: string | null;
  rssi_dbm: number | null;
  frequency_mhz: number | null;
  link_speed_mbps: number | null;
  ip_address: string | null;
  trigger: string | null;
  timestamp: string;
  age_minutes: number;
}

export interface CurrentPhoneStatus {
  battery_pct: number;
  is_charging: boolean;
  plug_type: string | null;
  battery_temp_c: number | null;
  low_power_mode: boolean | null;
  storage_used_bytes: number | null;
  storage_total_bytes: number | null;
  ram_used_bytes: number | null;
  ram_total_bytes: number | null;
  trigger: string | null;
  timestamp: string;
  age_minutes: number;
}

export interface KnownNetworkObservation {
  place_id: string;
  place_name: string;
  count: number;
  last_seen: string;
}

export interface KnownNetwork {
  bssid: string;
  ssid: string | null;
  label: string | null;
  manual_place_id: string | null;
  manual_place_name: string | null;
  place_observations: KnownNetworkObservation[];
  total_observations: number;
  first_seen: string;
  last_seen: string;
}

/** A known/deduced place the system has on file (where the user has been). */
export interface KnownPlace {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radius_m: number;
  address?: string;
  category?: string;
}

/** Subset of the awareness MCP where_is_user snapshot the map needs. */
interface WhereIsUserResponse {
  place?: string | null;
  source?: string;
  motion?: string | null;
  position?: {
    lat: number;
    lon: number;
    accuracy_m?: number | null;
    timestamp?: string;
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
    const data = await mcpCallJsonSafe<WhereIsUserResponse>("awareness", "where_is_user");
    const pos = data?.position;
    // No GPS fix (wifi-only / no signal) → nothing to pin on the map.
    if (!pos) return null;

    return {
      id: "current",
      location: { lat: pos.lat, lon: pos.lon },
      address: pos.address ?? undefined,
      matched_place: data?.place ?? undefined,
      accuracy: pos.accuracy_m ?? undefined,
      motion: data?.motion ?? undefined,
      timestamp: pos.timestamp ?? new Date().toISOString(),
    };
  } catch (err) {
    console.error("[locations] fetchCurrentLocation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fetchCurrentWifi(): Promise<CurrentWifi | null> {
  try {
    const data = await mcpCallJsonSafe<{ wifi?: CurrentWifi }>("awareness", "get_current_wifi");
    return data?.wifi ?? null;
  } catch (err) {
    console.error("[locations] fetchCurrentWifi failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function fetchCurrentPhoneStatus(): Promise<CurrentPhoneStatus | null> {
  try {
    const data = await mcpCallJsonSafe<{ phone_status?: CurrentPhoneStatus }>(
      "awareness",
      "get_phone_status",
    );
    return data?.phone_status ?? null;
  } catch (err) {
    console.error("[locations] fetchCurrentPhoneStatus failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

/** Deduced/known places (ll5_knowledge_places) the user has been — name + radius. */
export async function fetchKnownPlaces(limit: number = 200): Promise<KnownPlace[]> {
  try {
    const raw = await mcpCallList<Record<string, unknown>>("knowledge", "list_places", { limit });
    return raw
      .map((p) => {
        // list_places serializes Place: { id, name, type, address?, geo:{lat,lon}, radiusM? }
        const geo = p.geo as { lat?: number; lon?: number } | undefined;
        const lat = Number(geo?.lat ?? p.lat);
        const lon = Number(geo?.lon ?? p.lon);
        return {
          id: String(p.id ?? `${lat}-${lon}`),
          name: String(p.name ?? "Unnamed place"),
          lat,
          lon,
          radius_m: Number(p.radiusM ?? p.radius_m ?? 100),
          address: (p.address as string | undefined) ?? undefined,
          category: (p.type as string | undefined) ?? undefined,
        };
      })
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } catch (err) {
    console.error("[locations] fetchKnownPlaces failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchKnownNetworks(limit: number = 100): Promise<KnownNetwork[]> {
  try {
    const data = await mcpCallJsonSafe<{ networks?: KnownNetwork[] }>(
      "knowledge",
      "list_known_networks",
      { limit },
    );
    return data?.networks ?? [];
  } catch (err) {
    console.error("[locations] fetchKnownNetworks failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}
