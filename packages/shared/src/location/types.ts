/** Inputs and outputs for the canonical location resolver. All pure data — no I/O. */

export type Freshness = 'fresh' | 'stale' | 'very_stale';
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';
export type LocationSource = 'gps' | 'wifi' | 'gps+wifi' | 'stale_gps' | 'hold' | 'none';
export type LabelKind = 'place' | 'city' | null;

/** A known place a GPS fix matched (within its radius). */
export interface KnownPlaceMatch {
  placeId: string;
  placeName: string;
}

/** Latest GPS fix, with age + the known-place match already computed by the caller. */
export interface GpsSignal {
  lat: number;
  lon: number;
  accuracyM?: number;
  ageMs: number;
  /** Known place this fix falls within (caller runs the geo query), or null. */
  matchedPlace?: KnownPlaceMatch | null;
  /** Reverse-geocoded city, used for the city-level fallback label. */
  city?: string | null;
  address?: string | null;
}

/** A BSSID->place binding resolved by the caller from the networks index. */
export interface BssidPlace {
  placeId: string;
  placeName: string;
  /** True if a manual binding or >= BSSID_MIN_OBSERVATIONS learned observations. */
  confident: boolean;
}

/** Latest wifi connect/disconnect event, with age + resolved BSSID place. */
export interface WifiSignal {
  bssid?: string | null;
  ssid?: string | null;
  connected: boolean;
  ageMs: number;
  bssidPlace?: BssidPlace | null;
}

/** The prior committed semantic label (from the location-state doc) for hysteresis. */
export interface PriorLabel {
  label: string;
  kind: 'place' | 'city';
  placeId?: string;
}

export interface ResolveInput {
  gps?: GpsSignal | null;
  wifi?: WifiSignal | null;
  /** Prior committed label — enables departure hysteresis (don't flip off a place
   *  on a single low-confidence fix). Omit on the read path if not needed. */
  prior?: PriorLabel | null;
}

export interface RecentlyLeft {
  placeName: string;
  placeId: string;
  ageS: number;
}

/** The single canonical answer to "where is the user". */
export interface ResolvedLocation {
  /** Best place name (known place > city), or null when unknown. */
  place: string | null;
  placeId: string | null;
  confidence: Confidence;
  source: LocationSource;
  reasoning: string;

  /** Semantic label + kind used by the write-time transition state machine.
   *  label === place when a known place resolved; the city name when only
   *  city-level; null when in transit / unknown. */
  label: string | null;
  labelKind: LabelKind;

  recentlyLeft?: RecentlyLeft;
}
