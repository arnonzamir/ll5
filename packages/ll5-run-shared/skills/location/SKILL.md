---
name: location
description: How to read a where_is_user / get_situation location snapshot and compose a location line — field-by-field reading, deduction rules (motion, intent, hedging), GPS-jamming detail, travel-mode provenance, contextual cross-references (places, calendar, shopping list, patterns), and place saving. Invoke when composing a location line from a snapshot. CLAUDE.md keeps the rules that decide what to surface; this skill is the mechanics.
---

# Location — reading the snapshot

`where_is_user` is the lean call for **reactive, location-only** needs — when the user asks "where am I" or you need just a current fix. On a **proactive wake**, pull **`get_situation`** instead (it already contains this same location snapshot, plus time/activity/Bluetooth/calendar). The awareness MCP does the deterministic part and hands you ALL the location facts in one snapshot — **you do the deduction and the phrasing.** The snapshot gives you:
- `place` / `confidence` / `source` — the fused place and how sure it is.
- `position` — `lat`/`lon`, `accuracy_m`, `precision` (high/approximate/coarse), `age_s`, `freshness` (live/recent/stale/unknown), plus road/neighborhood/city.
- `motion` (stationary/walking/driving/unknown) + `speed_kmh` + `heading` (`bearing_deg`, `cardinal`).
- `trail` — recent fixes, newest first, so you can read trajectory (heading toward/away, slowing to a stop, looping back).
- `wifi` (the anchor) and `recently_left` ("just left Home 90s ago").
- `description` — a deterministic **baseline** line. A floor to fall back on, **not** a script to read verbatim.

## Deduce, don't parrot
- Refine `motion` with `speed_kmh` and context: ~18 km/h on a bike path → say **"cycling"**, not "driving"; ~3 km/h → "walking"; stopped → "at"/"near".
- Infer **intent** from `heading` + `trail` + the calendar and known places: heading toward the kids' school around pickup → "probably en route to school." Frame inferences as inferences ("looks like", "probably"), never as certainties.
- Compose the line yourself — the baseline `description` is just the safety net when nothing richer is deducible.

**Hedge by confidence and precision — never fake precision.** `confidence` low, `source` `wifi`/`stale_gps`/`hold`, or `precision` `coarse` → say so: "somewhere in Haifa, no precise fix", "probably still at the office — on its wifi, GPS is stale." A bare city is only honest when that's genuinely all you've got.

## GPS jamming
Regional GPS jamming can snap the chip to a far airport (Amman/Beirut) with confident-looking accuracy. The gateway flags such fixes `suspect` (wifi says home but GPS says abroad, or a 20km+ teleport while stationary) and `where_is_user` already excludes them — so a jammed point should never reach you as the user's location. If you ever DO see a sudden cross-border/implausible location with no travel trail and the user on home/office wifi, treat it as jamming, not reality: trust the wifi anchor / last good fix, and never tell the user they're somewhere they obviously aren't.

## `[Location]` events and travel mode
The gateway wakes you with a labeled `[Location]` event — `Arrived at X` / `Left X` / `Stopped` / `En route` — plus the rich description and `motion=`. A `[geofence]`-tagged event is the **confirmed** arrival/departure (the phone's on-device geofencing fired after a 60-second dwell, so a drive-past was already filtered) — trust it fully; the `[place match]` / `[city-level]` tags are the GPS-derived fallback. On each one, pull `get_situation` / `where_is_user` for the full picture (speed, heading, trail, nearby places) before you word it. Which events always get a `push_to_user(level: "notify")` and where restraint applies is in CLAUDE.md, "Location Intelligence".

**Always name the travel mode** in a movement update — driving, cycling, walking. The event tells you the mode AND its provenance: `motion=driving[activity]` / `motion=cycling[inferred]`, plus `speed=54km/h[gnss]` or `[derived]`. **Trust `[activity]`** — that's the phone's motion sensor (Activity Recognition) and is authoritative; name it directly. `[inferred]` is a guess from speed and can be wrong (e.g. cycling read as driving) — sanity-check it against `speed_kmh` (`[gnss]` is accurate, `[derived]` is approximate) and context (~18 km/h on a bike path is *cycling*). Set tone by mode: driving/fast → hands busy, shortest possible; on foot or stopped → fine to surface a relevant list. **Place labels are motion-gated at the source** — a known-place match while you're in transit (driving/cycling, or moving faster than a brisk walk) is suppressed, so you'll see `En route … [city-level]` rather than a false `Arrived at X`; still hedge by confidence/precision.

## Make it contextual — the snapshot is the input, meaning is the output
- Cross-reference with `list_places` — use known place names ("the gym", "the office") instead of addresses
- Check calendar — "you walked to your 10:30 dentist appointment"
- Check shopping list — "you passed by the supermarket, you had eggs on your list"
- Recognize patterns — "your usual morning walk" vs "somewhere you haven't been before"
- Give meaning — "looks like a morning errand run" not "traversed HaKovshim 60-106"

## Saving places
When saving places via `upsert_place`, always include coordinates (`location: {lat, lon}`) if available from GPS data. Without coordinates, geo-proximity queries (`near`) won't work.

If a location query returns no known places but the address matches a place you've seen before (like the user's home address), don't ask "want me to save it?" — check `list_places` by name/address first.

The goal: the user should feel understood, not like they're reading a GPS log.
