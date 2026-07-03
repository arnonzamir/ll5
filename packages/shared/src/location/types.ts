/** Inputs and outputs for the canonical location resolver. All pure data — no I/O. */

/** How recent a reading is, in human terms. One vocabulary across the whole
 *  system (GPS snapshot, device heartbeats) so nothing exposes two enums for
 *  "how fresh". The age thresholds differ per domain; the words don't. */
export type Freshness = 'live' | 'recent' | 'stale' | 'unknown';
/** How precise a GPS fix is, bucketed from its accuracy radius. */
export type Precision = 'high' | 'approximate' | 'coarse' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';
export type LocationSource = 'gps' | 'wifi' | 'gps+wifi' | 'wifi_scan' | 'stale_gps' | 'hold' | 'none';
export type LabelKind = 'place' | 'city' | null;
/** Inferred from device speed. 'unknown' when no speed is available. */
export type Motion = 'stationary' | 'walking' | 'driving' | 'unknown';

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
  // --- enrichment for a USEFUL description (vs a bare city) ---
  /** Reverse-geocoded street/road (zoom-18). */
  road?: string | null;
  /** Reverse-geocoded neighbourhood/suburb. */
  neighborhood?: string | null;
  /** Device heading in degrees (0=N, 90=E). For "heading <cardinal>". */
  bearingDeg?: number | null;
  /** Device speed in m/s. Drives the motion classification. */
  speedMps?: number | null;
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

/** One known network VISIBLE in the latest wifi scan (not necessarily joined),
 *  already matched by the caller to its BSSID->place binding (`connected` or
 *  `visible` — both participate). DECISION-021. */
export interface VisibleKnownNetwork {
  bssid?: string | null;
  ssid?: string | null;
  /** Signal strength in the scan, dBm (e.g. -58). */
  rssi: number;
  /** The place this BSSID is bound to. Non-confident bindings never vote. */
  place: BssidPlace;
}

/** The latest visible-scan fingerprint: scan age + the matched known networks. */
export interface VisibleScanSignal {
  ageMs: number;
  networks: VisibleKnownNetwork[];
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
  /** Already-matched known networks visible in the latest wifi SCAN (fresh
   *  scans only matter — a stale scan is ignored). Votes by place: it anchors
   *  when GPS is absent/stale/coarse, corroborates when a good GPS fix agrees,
   *  and loses to a fresh precise GPS fix that disagrees. DECISION-021. */
  visibleKnown?: VisibleScanSignal | null;
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

  /** USEFUL human description — the thing to actually show the user:
   *  a place name ("Home"), an in-transit line ("on Route 6, heading south —
   *  near Kfar Saba"), or a stationary landmark ("near Masada St, Haifa"). */
  description: string;
  /** Motion inferred from device speed. */
  motion: Motion;

  recentlyLeft?: RecentlyLeft;
}
