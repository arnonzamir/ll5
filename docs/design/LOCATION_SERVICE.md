# LocationService

## Problem

`get_current_location` previously returned the latest `ll5_awareness_locations` doc. That is a raw GPS fact, not the user's location. Consequences:

- Stale GPS (phone indoors, battery saver) is reported as "current" with misleading precision.
- Wifi BSSID co-occurrence (already collected and auto-learned into `ll5_knowledge_networks`) carried no weight in the answer.
- The agent has to re-derive presence each time by stitching together three tools.
- Arrival/departure detection in the gateway fires on GPS only; a wifi-driven arrival (phone connects to home AP after GPS was off) never triggers a notable event.

## Decision

Introduce a `LocationService` inside the awareness MCP that fuses GPS and wifi into a single "where is the user right now" answer with explicit provenance. The raw GPS data remains available via existing tools; the new service is the agent-facing abstraction.

## Inputs

| Signal | Source | Freshness budget | Confidence |
|---|---|---|---|
| GPS fix | `ll5_awareness_locations` latest | <5 min = fresh, 5–15 = stale-usable, >15 = stale | high if fresh + matched_place, medium otherwise |
| Wifi connection | `ll5_awareness_wifi_connections` latest | <10 min = fresh | depends on BSSID→place mapping |
| BSSID → place | `ll5_knowledge_networks` (manual_place_id wins, else dominant `place_observations.count`) | N/A | high if manual, medium if auto-learned ≥3 observations |

## Output

```ts
interface CurrentLocation {
  place: string | null;          // resolved human name, or null if unknown
  place_id: string | null;
  confidence: 'high' | 'medium' | 'low' | 'unknown';
  source: 'gps' | 'wifi' | 'gps+wifi' | 'stale_gps' | 'none';
  reasoning: string;             // short one-line explanation
  description: string;           // the USEFUL one-liner to report (see below)
  motion: 'stationary' | 'walking' | 'driving' | 'unknown';

  gps?: { lat; lon; accuracy_m; age_s; freshness; matched_place? };
  wifi?: { bssid; ssid; connected; age_s; place_from_bssid? };
}
```

## Useful descriptions (the "you're in Haifa is useless" fix)

A bare city label is true of a whole city all day — useless as an update. The
shared resolver (`@ll5/shared` `describeLocation`) builds a `description` from
the non-place GPS context so the agent and the user push always have something
worth saying. It is computed identically on the gateway write path and the
awareness read path (same module), and `motion` is classified from device speed
(`STATIONARY_SPEED_MPS=1`, `DRIVING_SPEED_MPS=6` m/s):

| Situation | `description` |
|---|---|
| At a saved place | the place name ("Home") |
| Driving | "driving on Route 6, heading south — near Kfar Saba" (road + bearing→cardinal + nearby city) |
| Stopped, unknown spot | "near Masada St, Haifa" (street/neighbourhood + city) |
| Only a city is known | "near Haifa" |
| No fix | coordinates |

The road/neighbourhood come from reverse geocoding (Nominatim `road` /
Google `route`, stored on the location doc); bearing/speed come from the device.

## Notification cadence — stops + trip pulse

The gateway transition path (`runTransition`) no longer pushes on every label
change (which firehosed town-by-town on a highway). Policy ("stops + pulse,
prefer more on less"):

- **Place arrival** (label changed to a saved place) → push (a "stop").
- **Driving** → suppress per-town city spam; emit ONE rich trip pulse at most
  every `TRIP_PULSE_MS` (12 min) — "Driving on Route 6, heading south — near
  Hadera".
- **Stationary / walking** → push when the label changes OR you just stopped
  (driving→stationary = settling somewhere), using the rich description.
- Anti-flap (`TRANSITION_DEDUP_MS`, 5 min) still suppresses A→B→A bounces; pulses
  are timer-gated so they're exempt. State carries `last_motion` + `last_pulse_at`.

## Fusion rules

Apply in order; first match wins:

1. **Fresh GPS + matched place + wifi agrees** → `high`, `gps+wifi`.
2. **Fresh GPS + matched place** (no wifi or wifi disagrees) → `high`, `gps`.
3. **Stale GPS but wifi fresh and BSSID resolves** → `medium`, `wifi`. Place = wifi-inferred; GPS reported as context.
4. **Fresh GPS without matched place + wifi resolves** → `medium`, `gps+wifi`. Place = wifi-inferred.
5. **Fresh GPS without matched place, no wifi** → `low`, `gps`. Place = null; return coordinates and address.
6. **Stale GPS, no wifi** → `low`, `stale_gps`.
7. **Nothing** → `unknown`, `none`.

"Fresh GPS" = ≤5 min. "Fresh wifi" = ≤10 min.

## Tool surface

- **`where_is_user`** — THE single location call (2026-06-12). Returns one rich snapshot of deterministic facts: `place`/`confidence`/`source`/`reasoning`, a `position` block (`lat`/`lon`/`accuracy_m`/`precision`/`age_s`/`freshness`/`road`/`neighborhood`/`city`/`address`), `motion`+`speed_kmh`+`heading`, a recent `trail` (last ~12 fixes / 30 min), the `wifi` anchor, and `recently_left`. `description` is a deterministic baseline/floor — the MCP does the deterministic part, the agent does the deduction and phrasing.
- **`get_current_location`** — deprecated alias of `where_is_user`. Same snapshot plus a flat `location` block (`lat`/`lon`/`accuracy`/`timestamp`/`freshness`/`place_name`/`address`) for legacy clients (dashboard map).
- **`get_situation`** — embeds the same snapshot verbatim as `current_location` (one shape, one vocabulary).
- **`query_location_history`** — unchanged. Raw historical queries are still raw.

Freshness is unified to `live`/`recent`/`stale`/`unknown` across the whole agent surface (shared `Freshness`); the resolver computes its usability tiers off raw age, not an enum.

Existing `delete_location_point` is unchanged.

## Non-goals (for this iteration)

- Moving gateway-side movement detection into the fusion layer. It will still fire on GPS in `processLocation`; a follow-up can port it to run off `LocationService.getCurrentLocation` at tool-call time or on a scheduler.
- Calendar-location as a third signal. Tracked as future work.
- Backfilling the `notable_events` index with entries the gateway previously emitted in the wrong shape (those docs are silently unreadable but not harmful; leave in place).

## Rollout

Atomic with the gateway notable-events shape fix. Old clients keep working because `get_current_location` is additive.
