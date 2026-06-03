# DECISION-009: One canonical location resolver in @ll5/shared

## Context

"Where is the user / what place are they at" was computed in **two independent
places** that could disagree:

- **Write path** — `gateway/processors/location.ts` ran a GPS-only state machine
  (`deriveLabel`: 100m known-place match + reverse-geocoded city) that drove the
  `[Location]` system messages, the "You're home/in X" FCM pushes, and the
  `ll5_awareness_location_state` doc. It **never looked at WiFi**.
- **Read path** — `awareness/services/location-service.ts` ran a 7-tier GPS+WiFi
  fusion (`getCurrentLocation`) behind `where_is_user` / `get_situation` /
  `get_current_location`.

Symptom that exposed it: at home, indoor GPS hovers at 50–100 m accuracy right at
the edge of the 100 m "Home" radius, so the write path flapped Home ↔ city
("Zikhron Yaakov") every push and spammed notifications — even though the user was
continuously on the home WiFi (BSSID seen 18,063× at Home), which the read path
knew about but the write path ignored. Thresholds were also duplicated and partly
divergent across gateway / awareness / dashboard / personal-knowledge (place
radius hardcoded at 100 m in ≥4 spots; two haversines; two freshness ladders).

## Decision

**Put the entire location-resolution brain in one pure module — `@ll5/shared`
`location/` — and have both the gateway (write) and awareness (read) call it.**

- `constants.ts` — every threshold (accuracy gates, drift/teleport limits,
  freshness tiers, default place radius, BSSID confidence, stay-point params,
  anti-flap window). Single source.
- `geo.ts` — the one `haversineMeters`.
- `filter.ts` — `gateAccuracy()` + `detectDriftGlitch()` (write-time plausibility).
- `resolve.ts` — `resolveLocation(signals)`: the 7-tier GPS+WiFi fusion **plus**
  (a) WiFi anchoring (a confident BSSID→place wins when GPS has no/stale match —
  this is what stops the home flapping), (b) a city-level fallback label, and
  (c) **departure hysteresis** — when the prior committed label is a known place,
  a single low-accuracy or stale fix can't flip it to city/unknown; only a fresh,
  good-accuracy fix that finds no place (a real departure) releases it.

ES access stays in each package's repositories (the no-cross-MCP-call rule holds);
only the decision is shared. The gateway now also reads the latest WiFi at ingest
and passes the prior label, so the transition path is WiFi-aware and hysteretic.

Also: **per-place `radius_m`** (default 100) on `ll5_knowledge_places`, honored by
`matchKnownPlace`, so a large home compound can widen its radius instead of every
place sharing a fixed 100 m.

## Alternatives considered

- **Patch only the gateway** (add WiFi + hysteresis there, leave the two systems
  separate). Rejected — the divergence would persist and re-grow; the user asked
  to consolidate "all considerations" into one place.
- **A runtime location service both MCPs call.** Rejected — violates "no
  cross-MCP calls" and adds a network hop/coupling. A shared pure library gives
  one brain with zero coupling.
- **Bump the Home radius / add a wider global radius.** Helps the symptom, not the
  root cause (two resolvers). Per-place `radius_m` is added as a complementary
  lever, not the fix.

## Consequences

- Gateway and agent can no longer disagree about the current place.
- Far fewer false location pushes at home (verified by tests: home WiFi + 100 m-edge
  GPS → stays Home, zero city pushes; low-accuracy fix → hysteresis holds; clean
  far fix → real departure still fires).
- One place to tune every threshold. New shared unit tests
  (`shared/src/__tests__/location-resolve.test.ts`) cover the tiers, anchoring,
  hysteresis, gating, and drift.
- `deriveLabel` (gateway) removed — superseded by `resolveLocation`.
- Stay-point/geo-search clustering still has its own constants (now also mirrored
  in shared); those are a distinct algorithm, not place resolution.
