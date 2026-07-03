# DECISION-021 — Wifi scan fingerprinting: see all visible networks, map them to places

Status: accepted — 2026-07-03

## Context

The Android app only reports the wifi network the phone is CONNECTED to
(`WifiRepository` connect/disconnect/ssid-change events → `ll5_awareness_wifi_connections`,
fused into location via the known_networks BSSID→place bindings, DECISION-009).
That leaves location resolution blind whenever the phone isn't connected: walking
around the neighborhood, visiting a place whose wifi we don't join, indoors where
GPS is weak. The user's ask: the agent should see ALL wifi networks around the
phone, and they should map to locations.

Visible-network sets are a strong place fingerprint: an unfamiliar apartment still
shows the same 8 neighbor APs every visit; a known place is recognizable from its
surrounding networks even without joining any of them.

## Decision

### Capture (ll5-android)

A `wifi_scan` webhook item pushed alongside the existing push cycles (location
batch + device heartbeat): the top **12 networks by RSSI** from
`WifiManager.getScanResults()` (the OS-cached results — no forced `startScan`, so
no throttling/battery cost), rate-limited to **≥5 min between pushes** and skipped
entirely when the visible BSSID set is unchanged since the last push (resent
anyway after 30 min so freshness is bounded). Offline-queued in Room like other
event types. Requires the already-granted `ACCESS_FINE_LOCATION`; the
`NEARBY_WIFI_DEVICES` declaration must NOT carry `neverForLocation` (that flag
strips location-relevant scan data).

Payload contract (frozen across repos):
```json
{ "type": "wifi_scan", "data": {
    "timestamp": "ISO",
    "networks": [{ "ssid": "string|null", "bssid": "aa:bb:cc:dd:ee:ff",
                    "rssi": -58, "frequency_mhz": 5240 }],
    "connected_bssid": "string|null" } }
```

### Storage (gateway → ES)

New index **`ll5_awareness_wifi_scans`** (mapping in shared
`indices/awareness.ts`): `user_id`, `timestamp`, `networks` (nested: ssid/bssid
keyword, rssi/frequency_mhz integer), `connected_bssid`. One doc per accepted
scan (~≤12/h/user worst case — far below the wifi_connections volume).

### Mapping to places

1. **Bindings**: `known_networks` gains `binding: "connected" | "visible"`
   (existing rows default `connected`). **Auto-learn**: when a scan arrives while
   the location state has the user confidently AT a known place, the gateway
   upserts `visible` bindings for that place from the scan's networks (min RSSI
   −75 dBm, cap 10 visible bindings per place, observation-counted like the
   existing G8-capped auto-learn). Neighbor APs visible from home ARE the home
   fingerprint — that is the point; `visible` bindings never claim the AP is the
   place's own network.
2. **Resolution**: shared `resolveLocation` gains a **visible-fingerprint tier**
   below the connected-wifi anchor: from the latest scan (fresh ≤10 min), the
   already-matched visible known networks vote by place — **≥2 BSSIDs for the
   same place, or 1 at RSSI ≥ −65** → place candidate, precision `approximate`.
   It anchors when GPS is absent/stale/coarse and corroborates (confidence boost)
   when GPS agrees; a fresh high-accuracy GPS fix that disagrees wins (drive-past
   protection stays intact).
3. **Agent surface**: `where_is_user` adds a `wifi.visible` block —
   `{scan_age_s, total_visible, known: [{place, ssid, rssi}]}` — so the agent
   sees the surroundings, not just the joined network; `get_situation` inherits
   via the shared snapshot.

## Alternatives considered

- **Reuse `ll5_awareness_wifi_connections` with an event kind.** Rejected: scans
  are multi-network documents with different query patterns (latest-fingerprint
  lookup, nested match) and would pollute the 239k-doc connect/disconnect stream.
- **Force `startScan()` on a timer for fresher data.** Rejected for v1: Android
  throttles it hard (4/2min foreground, 1/30min background), it costs battery,
  and cached results piggyback on the OS's own frequent scans.
- **Full RSSI-vector fingerprint matching (kNN over signal strengths).** Deferred:
  set-membership voting on known BSSIDs covers the actual use cases (recognize a
  known place without joining wifi); vector matching adds tuning surface with no
  current consumer.

## Consequences

- Location resolution works un-connected: arriving at known places, indoor
  no-GPS contexts, and "which building am I actually in" all improve.
- New surface: one ES index, one webhook item type + processor path, one resolver
  tier, `known_networks.binding`, `where_is_user.wifi.visible` (+ tests). Android
  gains a scan collector + Room queue entity.
- Auto-learn grows known_networks (bounded: cap 10 visible/place); recall of a
  place's fingerprint improves with each confident visit.
- Privacy posture unchanged: scans stay in the user's own ES, same as GPS.
- Deploy: gateway + awareness + knowledge together (CI); Android via local build
  + manual install (no CI in that repo).
