import {
  GPS_FRESH_MS,
  GPS_STALE_USABLE_MS,
  WIFI_FRESH_MS,
  WIFI_CONNECTED_ANCHOR_MS,
  DEPARTURE_ACCURACY_M,
  DRIVING_SPEED_MPS,
  LOW_ACCURACY_METERS,
  SCAN_FRESH_MS,
  VISIBLE_MIN_MATCHES,
  VISIBLE_STRONG_RSSI,
} from './constants.js';
import { describeLocation } from './describe.js';
import type {
  ResolveInput,
  ResolvedLocation,
  BssidPlace,
  KnownPlaceMatch,
} from './types.js';

/** The resolved answer before the human description/motion are attached. */
type Core = Omit<ResolvedLocation, 'description' | 'motion'>;

/**
 * THE canonical "where is the user" decision. Pure over the signals the caller
 * supplies (latest GPS + its known-place match, latest wifi + its BSSID->place,
 * and the prior committed label). Used by BOTH the gateway write/transition path
 * and the awareness read/fusion path so they can never disagree.
 *
 * Layers:
 *  1. GPS+wifi fusion (7 tiers) → place / confidence / source / reasoning.
 *  2. Wifi anchoring: a confident BSSID->place wins when GPS has no/stale place
 *     match (this is what stops home GPS-jitter flapping to the city label).
 *  2b. Visible-fingerprint tier (DECISION-021): known networks visible in a
 *     fresh SCAN vote by place; anchors when GPS is absent/stale/coarse and
 *     no connected-wifi anchor applies, corroborates when GPS agrees, and
 *     loses to a fresh precise disagreeing GPS fix.
 *  3. City-level fallback label when no known place but a city is known.
 *  4. Departure hysteresis: when `prior` is a known place and the current fix
 *     can't confidently say you left, HOLD the prior place instead of flipping
 *     to city/unknown on a single low-accuracy or stale fix.
 */
export function resolveLocation(input: ResolveInput): ResolvedLocation {
  const gps = input.gps ?? null;
  const wifi = input.wifi ?? null;
  const prior = input.prior ?? null;

  // GPS-fix usability tiers, straight off the age (no enum needed): "fresh" =
  // trusted without wifi; "usable" = stale but still good enough to place you.
  const gpsFresh = !!gps && gps.ageMs < GPS_FRESH_MS;
  const gpsUsable = !!gps && gps.ageMs < GPS_STALE_USABLE_MS;
  // A known place matched only by GPS proximity (you're within the ~100m place
  // radius) while DRIVING is a fly-by, not a visit — suppress it so we never label
  // you "at X" when you're just driving past. A genuine visit re-registers once you
  // slow/stop, or via a connected-wifi anchor (which a drive-by never trips).
  const drivingThrough = !!gps && gps.speedMps != null && gps.speedMps >= DRIVING_SPEED_MPS;
  const gpsPlace: KnownPlaceMatch | null = drivingThrough ? null : (gps?.matchedPlace ?? null);
  const ageS = gps ? Math.floor(gps.ageMs / 1000) : null;

  // A CONNECTED wifi event anchors you to its (confident) place until a disconnect
  // arrives or it ages past WIFI_CONNECTED_ANCHOR_MS — not the tight WIFI_FRESH_MS,
  // because heartbeats are sparse. recently-left still uses WIFI_FRESH_MS below.
  const wifiPlace: BssidPlace | null =
    wifi && wifi.connected && wifi.ageMs < WIFI_CONNECTED_ANCHOR_MS && wifi.bssidPlace?.confident
      ? wifi.bssidPlace
      : null;

  const city = gps?.city ?? null;

  // Visible-scan fingerprint tier (DECISION-021): from a FRESH scan (< SCAN_FRESH_MS
  // — a stale scan is ignored entirely), the already-matched CONFIDENT known
  // networks vote by place. >= VISIBLE_MIN_MATCHES same-place BSSIDs, or a single
  // one at RSSI >= VISIBLE_STRONG_RSSI, elect the place as a candidate (precision
  // `approximate` — a fingerprint says "at/around", never a coordinate).
  interface ScanVote {
    place: BssidPlace;
    votes: number;
    bestRssi: number;
  }
  const scan = input.visibleKnown ?? null;
  const scanFresh = !!scan && scan.ageMs < SCAN_FRESH_MS;
  let scanPlace: ScanVote | null = null;
  if (scan && scanFresh && scan.networks.length > 0) {
    const byPlace = new Map<string, ScanVote>();
    for (const n of scan.networks) {
      if (!n.place.confident) continue; // non-confident bindings never vote
      const cur = byPlace.get(n.place.placeId);
      if (cur) {
        cur.votes += 1;
        if (n.rssi > cur.bestRssi) cur.bestRssi = n.rssi;
      } else {
        byPlace.set(n.place.placeId, { place: n.place, votes: 1, bestRssi: n.rssi });
      }
    }
    scanPlace =
      [...byPlace.values()]
        .filter((v) => v.votes >= VISIBLE_MIN_MATCHES || v.bestRssi >= VISIBLE_STRONG_RSSI)
        .sort((a, b) => b.votes - a.votes || b.bestRssi - a.bestRssi)[0] ?? null;
  }
  const scanAgeS = scan ? Math.floor(scan.ageMs / 1000) : null;

  // recently-left hint: GPS not fresh + a recent wifi DISCONNECT from a known place.
  const wifiFresh = !!wifi && wifi.ageMs < WIFI_FRESH_MS;
  let recentlyLeft: ResolvedLocation['recentlyLeft'];
  if (!gpsFresh && wifi && !wifi.connected && wifiFresh && wifi.bssidPlace?.confident) {
    recentlyLeft = {
      placeName: wifi.bssidPlace.placeName,
      placeId: wifi.bssidPlace.placeId,
      ageS: Math.floor(wifi.ageMs / 1000),
    };
  }

  let result = decide();

  // Departure hysteresis (write path only — read path omits `prior`).
  if (prior && prior.kind === 'place' && result.labelKind !== 'place') {
    // A fix can only assert "you left" if it's genuinely precise — accuracy at/over
    // the place radius (the ~100m home jitter) can't tell inside from outside.
    const preciseEnough = gps?.accuracyM != null && gps.accuracyM <= DEPARTURE_ACCURACY_M;
    const confidentDeparture = gpsFresh && preciseEnough; // clean outdoor fix, no known place
    if (!confidentDeparture) {
      result = {
        place: prior.label,
        placeId: prior.placeId ?? null,
        confidence: 'low',
        source: 'hold',
        reasoning:
          `holding ${prior.label} — departure not confident (` +
          `${gps ? (gpsFresh ? 'low-accuracy' : 'stale') + ' fix' : 'no fix'})`,
        label: prior.label,
        labelKind: 'place',
      };
    }
  }

  if (recentlyLeft && result.source !== 'hold') {
    result.recentlyLeft = recentlyLeft;
    result.reasoning += `; recently left ${recentlyLeft.placeName} (wifi disconnect ${recentlyLeft.ageS}s ago)`;
  }

  // Attach the USEFUL human description + motion. A known place is its own best
  // description; otherwise build "driving on X heading Y near Z" / "near Street, City".
  const { description, motion } = describeLocation(
    gps,
    result.labelKind === 'place' ? result.label : null,
  );
  return { ...result, description, motion };

  function decide(): Core {
    // Corroboration (DECISION-021): the visible fingerprint agreeing with a
    // GPS-matched place is extra reasoning weight on the GPS tiers below.
    const scanAgrees = !!scanPlace && !!gpsPlace && scanPlace.place.placeId === gpsPlace.placeId;
    const corroboration = scanAgrees
      ? `; visible wifi fingerprint corroborates (${scanPlace!.votes} known network(s))`
      : '';

    // 1. Fresh GPS + matched place + wifi agrees
    if (gpsFresh && gpsPlace && wifiPlace && wifiPlace.placeName === gpsPlace.placeName) {
      return place(gpsPlace.placeName, wifiPlace.placeId, 'high', 'gps+wifi',
        `GPS (${ageS}s) at ${gpsPlace.placeName}, wifi confirms${corroboration}`);
    }
    // 2. Fresh GPS + matched place (wifi silent/disagrees)
    if (gpsFresh && gpsPlace) {
      return place(gpsPlace.placeName, gpsPlace.placeId, 'high', 'gps',
        `GPS fix (${ageS}s old) at ${gpsPlace.placeName}${corroboration}`);
    }
    // 3. Stale GPS, wifi fresh + BSSID resolves
    if (!gpsFresh && wifiPlace) {
      return place(wifiPlace.placeName, wifiPlace.placeId, 'medium', 'wifi',
        `GPS stale (${ageS ?? 'n/a'}s), wifi BSSID maps to ${wifiPlace.placeName}`);
    }
    // 4. Fresh GPS without matched place + wifi resolves  (the home-drift fix)
    if (gpsFresh && !gpsPlace && wifiPlace) {
      return place(wifiPlace.placeName, wifiPlace.placeId, 'medium', 'gps+wifi',
        `GPS fresh but no place match; wifi BSSID → ${wifiPlace.placeName}`);
    }
    // 4b. Visible-fingerprint anchor (DECISION-021) — below the connected-wifi
    // tiers. The scan's known networks elected a place and GPS can't do better:
    // absent, stale, or too coarse (accuracy > LOW_ACCURACY_METERS) to disagree.
    // A FRESH fix at/under that accuracy without a place match falls through to
    // tier 5 instead — a precise disagreeing GPS wins (drive-past protection).
    const gpsCoarse = !!gps && gps.accuracyM != null && gps.accuracyM > LOW_ACCURACY_METERS;
    if (scanPlace && !wifiPlace && (!gps || !gpsFresh || gpsCoarse)) {
      const p = scanPlace.place;
      const staleGpsAgrees = !gpsFresh && gpsUsable && gpsPlace?.placeId === p.placeId;
      return place(p.placeName, p.placeId, 'medium', 'wifi_scan',
        `visible wifi fingerprint → ${p.placeName} (approximate: ${scanPlace.votes} known ` +
        `network(s), strongest ${scanPlace.bestRssi} dBm, scan ${scanAgeS}s old` +
        `${staleGpsAgrees ? '; stale GPS agrees' : ''})`);
    }
    // 5. Fresh GPS without matched place, no wifi anchor → city-level / unknown
    if (gpsFresh && !gpsPlace) {
      return cityOrNull('gps', 'low',
        `GPS fresh at (${gps!.lat.toFixed(4)}, ${gps!.lon.toFixed(4)}) — no known place`);
    }
    // 6. Stale (usable) GPS, no wifi anchor
    if (gpsUsable) {
      if (gpsPlace) {
        return place(gpsPlace.placeName, gpsPlace.placeId, 'low', 'stale_gps',
          `GPS stale (${ageS}s old), no wifi`);
      }
      return cityOrNull('stale_gps', 'low', `GPS stale (${ageS}s old), no wifi, no place`);
    }
    // 7. Nothing
    return {
      place: null, placeId: null, confidence: 'unknown', source: 'none',
      reasoning: 'No recent GPS or wifi signal', label: null, labelKind: null,
    };
  }

  function place(
    name: string, id: string, confidence: ResolvedLocation['confidence'],
    source: ResolvedLocation['source'], reasoning: string,
  ): Core {
    return { place: name, placeId: id, confidence, source, reasoning, label: name, labelKind: 'place' };
  }

  function cityOrNull(
    source: ResolvedLocation['source'], confidence: ResolvedLocation['confidence'], reasoning: string,
  ): Core {
    return {
      place: null, placeId: null, confidence, source, reasoning,
      label: city ?? null, labelKind: city ? 'city' : null,
    };
  }
}
