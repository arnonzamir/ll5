/**
 * Single source of truth for every location/place threshold in LL5.
 *
 * Before this module these constants were duplicated and partly divergent across
 * the gateway (write/ingest path), the awareness MCP (read/fusion path), the
 * dashboard, and personal-knowledge. They now live here and are imported
 * everywhere, so the gateway and the agent can never disagree about "where am I".
 */

// --- Known-place matching -------------------------------------------------
/** Default radius (m) within which a GPS fix counts as "at" a known place.
 *  Per-place `radius_m` overrides this when set on the place doc. */
export const DEFAULT_PLACE_RADIUS_M = 100;

// --- GPS accuracy gating (write-time) -------------------------------------
/** Above this accuracy (m) a fix is "low accuracy" — kept but flagged so the
 *  resolver down-weights it and never drives a transition off it alone. */
export const LOW_ACCURACY_METERS = 100;
/** Above this accuracy (m) the fix is garbage (km-scale cell estimate) — dropped. */
export const MAX_ACCURACY_METERS = 2000;

// --- Drift / teleport filtering (write-time) ------------------------------
/** Only compare against a predecessor seen within this many minutes. */
export const DRIFT_WINDOW_MIN = 10;
/** Speed (km/h) implausible for a short city hop; needs device-speed corroboration. */
export const IMPLAUSIBLE_SPEED_KMH = 150;
/** Absolute physical ceiling (km/h) — beyond this nothing is real travel. */
export const ABSOLUTE_MAX_SPEED_KMH = 1000;
/** Device speed (km/h) at/below which we treat the device as "not really moving". */
export const DEVICE_STATIONARY_SPEED_KMH = 30;
/** How closely computed vs device speed must agree (ratio) to confirm real travel. */
export const SPEED_AGREEMENT_RATIO = 0.5;
/** A >this-many-km hop within KNOWN_PLACE_DRIFT_MIN of being AT a known place is jitter. */
export const KNOWN_PLACE_DRIFT_KM = 0.5;
export const KNOWN_PLACE_DRIFT_MIN = 5;

// --- Freshness tiers ------------------------------------------------------
/** GPS younger than this is "fresh" — trusted without wifi confirmation. */
export const GPS_FRESH_MS = 5 * 60 * 1000;
/** GPS younger than this is "stale" but still usable; older is "very_stale". */
export const GPS_STALE_USABLE_MS = 15 * 60 * 1000;
/** Wifi event younger than this is "fresh" — used for the recently-left disconnect hint. */
export const WIFI_FRESH_MS = 10 * 60 * 1000;
/**
 * How long a CONNECTED wifi event still anchors you to its place. A connect (or
 * heartbeat-while-connected) means you're on that network until a DISCONNECT
 * event arrives — and Android's wifi heartbeats are sparse (~30–60 min apart),
 * so a 10-min window misses them and lets home GPS-jitter flap. Anchoring on a
 * connected event for up to 2h covers a missed heartbeat; a real departure fires
 * a disconnect (dropping the anchor) and/or a precise GPS fix elsewhere.
 */
export const WIFI_CONNECTED_ANCHOR_MS = 2 * 60 * 60 * 1000;

// --- BSSID -> place confidence -------------------------------------------
/** A learned BSSID->place binding needs at least this many observations to be
 *  trusted (a manual binding is always trusted regardless of count). */
export const BSSID_MIN_OBSERVATIONS = 3;

// --- Stay-point / visit detection ----------------------------------------
export const STAY_RADIUS_M = 150;
export const MIN_DWELL_MS = 10 * 60 * 1000;
export const MAX_GAP_MS = 30 * 60 * 1000;

// --- Departure hysteresis -------------------------------------------------
/**
 * To call "you left a known place" off a single GPS fix, the fix must be at least
 * this precise (m). A fix whose accuracy is near/over the place radius can't tell
 * inside-from-outside, so it must NOT release a held place — that was the home
 * jitter (accuracy ~100m at the 100m radius edge). Only a clearly-precise fix
 * (and fresh, and with no wifi anchor) counts as a real departure.
 */
export const DEPARTURE_ACCURACY_M = 50;

// --- Place-transition anti-flap (write-time) ------------------------------
/** Don't re-push the same label within this window (handles A->B->A bounce). */
export const TRANSITION_DEDUP_MS = 5 * 60 * 1000;
