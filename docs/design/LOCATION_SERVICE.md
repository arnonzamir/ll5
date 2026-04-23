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

  gps?: { lat; lon; accuracy_m; age_s; freshness; matched_place? };
  wifi?: { bssid; ssid; connected; age_s; place_from_bssid? };
}
```

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

- **`get_current_location`** — kept, rewritten internally to call `LocationService`. Response preserves existing fields (`lat`, `lon`, `freshness`, `place_name`, `address`) for backward compatibility, plus adds `confidence`, `source`, `reasoning`, and an optional `wifi` block.
- **`where_is_user`** — new, agent-friendly. Returns only the fused result (no raw GPS fields at the top level).
- **`query_location_history`** — unchanged for now. Raw historical queries are still raw.

Existing `delete_location_point` is unchanged.

## Non-goals (for this iteration)

- Moving gateway-side movement detection into the fusion layer. It will still fire on GPS in `processLocation`; a follow-up can port it to run off `LocationService.getCurrentLocation` at tool-call time or on a scheduler.
- Calendar-location as a third signal. Tracked as future work.
- Backfilling the `notable_events` index with entries the gateway previously emitted in the wrong shape (those docs are silently unreadable but not harmful; leave in place).

## Rollout

Atomic with the gateway notable-events shape fix. Old clients keep working because `get_current_location` is additive.
