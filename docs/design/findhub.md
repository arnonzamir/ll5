# Google Find Hub integration

## Problem

LL5 knows where the **user** is (phone GPS → gateway → `ll5_awareness_locations`)
but has no way to locate **things** (keys, bag, car tag) or **other devices**
shared to the user's Google account (a partner's phone, a tablet). The user
wants "where are my keys?" / "where is the iPad?" answerable.

Google's Find Hub (formerly Find My Device) network already tracks exactly
these, and [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) is
a mature reverse-engineered client for it.

## Decision

Add a **Python sidecar** (`packages/findhub-poller`) that wraps GoogleFindMyTools,
polls the network on an interval, and pushes each fix to the gateway as a new
`tracked_device` webhook item. The gateway processes it into a new
current-state index; the awareness MCP exposes read tools.

See [DECISION-008](../decisions/DECISION-008-findhub-python-sidecar.md) for the
sidecar-vs-port and separate-index rationale.

## Data flow

```
GoogleFindMyTools (Find Hub network, E2EE-decrypted)
  → findhub-poller (Python, holds Auth/secrets.json)
  → POST /webhook  { items: [{ type: 'tracked_device', ... }] }   (Bearer ll5.<token>)
  → gateway processTrackedDevice: reverse-geocode + place-match
  → ES upsert ll5_awareness_tracked_devices  (id = `${user_id}:${device_id}`)
  → awareness MCP: get_tracked_devices / where_is_device
```

This is intentionally NOT the `processLocation` path:

| | `location` (user GPS) | `tracked_device` (Find Hub) |
|---|---|---|
| Subject | the user | a thing / another device |
| Index | `ll5_awareness_locations` (append) | `ll5_awareness_tracked_devices` (upsert per device) |
| Drift filtering | yes (stream of fixes) | no (single crowd-sourced last-known fix) |
| Place transitions / notifications | yes | no (v1) |

## `tracked_device` push item

```
type: 'tracked_device'
device_id:   string   # stable Google canonic id (upsert key)
name:        string
device_type: 'phone'|'tablet'|'watch'|'tracker'|'unknown'  (optional)
timestamp:   ISO8601   # when the network last located it
lat, lon:    number
accuracy_m:  number    (optional)
battery_pct: number    (optional)
semantic_name: string  (optional)  # Google's own place label for the fix
```

## Index `ll5_awareness_tracked_devices`

Defined in `@ll5/shared` `AWARENESS_INDICES` (so gateway-writer and
awareness-reader can't drift). One doc per device, upserted. `location` is a
`geo_point`. `last_seen` = network freshness; `updated_at` = ingest time.

## Tools

- `get_tracked_devices(limit?)` — all devices, most-recently-seen first.
- `where_is_device(name)` — fuzzy match one device by name.

Both collapse provenance into a single `place` (saved-place match > Google
semantic label > geocoded address > raw coords) and report `freshness` /
`age_minutes` so the agent can judge a stale fix.

## Auth

GoogleFindMyTools needs Chrome once to mint `Auth/secrets.json`; done locally,
the file is mounted into the (Chrome-less) container. It can expire → re-mint
and redeploy. See the poller README.

## Risks

- Upstream is experimental; the network protocol can change. All library calls
  are isolated in `findhub_client.py`. The adapter skips unparseable fixes
  loudly rather than faking `0,0`.
- Find Hub freshness is patchy (depends on nearby Android devices). Tools
  surface staleness; they never present a stale fix as live.

## Non-goals (v1)

- Notifications on a tracker leaving a place (designed-for but deferred — would
  reuse the gateway place-transition machinery against the per-device state).
- Location history / trail per device (current-state only for now).
- Dashboard map rendering.
- Registering custom ESP32 trackers (GoogleFindMyTools supports it; out of scope).
