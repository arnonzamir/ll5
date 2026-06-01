"""
Adapter around GoogleFindMyTools (https://github.com/leonboe1/GoogleFindMyTools).

This is the ONLY module that touches the upstream library. It is isolated on
purpose: GoogleFindMyTools is an experimental, reverse-engineered project whose
function names and return shapes change between commits. If a future version
breaks, fix it HERE and the rest of the poller is unaffected.

Verified entry points (as of 2026-06):
  - NovaApi.ListDevices.nbe_list_devices.list_devices()           -> device list
  - NovaApi.ExecuteAction.LocateTracker.location_request
        .get_location_data_for_device(canonic_id, name)          -> location(s)

Because the exact field names of the returned objects are not stable, the
normalizers below try several spellings and SKIP (with a loud log) anything we
can't confidently parse — never silently emitting a bogus 0,0 fix.
"""

import logging
from dataclasses import dataclass
from typing import Any, Optional

log = logging.getLogger("findhub.client")


@dataclass
class DeviceFix:
    device_id: str
    name: str
    lat: float
    lon: float
    timestamp: str          # ISO 8601 with offset
    device_type: str = "unknown"
    accuracy_m: Optional[float] = None
    battery_pct: Optional[float] = None
    semantic_name: Optional[str] = None


def _first(obj: Any, *names: str) -> Any:
    """Return the first present attribute/key among `names`, else None."""
    for n in names:
        if isinstance(obj, dict) and n in obj and obj[n] is not None:
            return obj[n]
        if hasattr(obj, n):
            v = getattr(obj, n)
            if v is not None:
                return v
    return None


def list_device_ids() -> list[tuple[str, str]]:
    """Return [(canonic_id, name), ...] for every device on the account.

    Wraps upstream list_devices(). The raw result is a protobuf-ish object; we
    extract canonic ids + names defensively. Upstream main.py uses a helper to
    pull canonic ids — we mirror that but fall back to attribute scanning.
    """
    from NovaApi.ListDevices.nbe_list_devices import list_devices

    raw = list_devices()
    devices: list[tuple[str, str]] = []

    # Newer upstream exposes a parsed list; older returns a protobuf with
    # `.deviceMetadata`. Handle both, plus a plain list of dicts.
    candidates = _first(raw, "deviceMetadata", "devices", "device_metadata") or raw
    try:
        iterable = list(candidates)
    except TypeError:
        log.error("list_devices() returned a non-iterable (%s); upstream API likely changed", type(raw))
        return []

    for d in iterable:
        canonic = _first(d, "canonicId", "canonic_id", "id")
        # canonic id is sometimes nested under an identifier object
        if canonic is not None and not isinstance(canonic, str):
            canonic = _first(canonic, "id", "canonicId", "canonic_id") or str(canonic)
        name = _first(d, "userDefinedName", "name", "deviceName") or "Unknown device"
        if canonic:
            devices.append((str(canonic), str(name)))
        else:
            log.warning("Skipping a device with no resolvable canonic id: %r", d)

    log.info("Discovered %d device(s) on the account", len(devices))
    return devices


def _normalize_location(canonic_id: str, name: str, loc: Any) -> Optional[DeviceFix]:
    lat = _first(loc, "latitude", "lat", "deg_lat")
    lon = _first(loc, "longitude", "lon", "lng", "deg_lon")
    if lat is None or lon is None:
        log.warning("No lat/lon in location for %s (%s); skipping. raw=%r", name, canonic_id, loc)
        return None

    ts = _first(loc, "timestamp", "time", "lastSeen", "last_seen", "isoTime")
    if ts is None:
        log.warning("No timestamp in location for %s (%s); skipping (won't fake one)", name, canonic_id)
        return None

    return DeviceFix(
        device_id=canonic_id,
        name=name,
        lat=float(lat),
        lon=float(lon),
        timestamp=_to_iso(ts),
        accuracy_m=_maybe_float(_first(loc, "accuracy", "accuracy_m", "horizontalAccuracy")),
        battery_pct=_maybe_float(_first(loc, "battery", "batteryLevel", "battery_pct")),
        semantic_name=_first(loc, "semanticName", "semantic_name", "placeName"),
    )


def get_device_fix(canonic_id: str, name: str) -> Optional[DeviceFix]:
    """Request the latest decrypted location for one device. None if unavailable."""
    from NovaApi.ExecuteAction.LocateTracker.location_request import (
        get_location_data_for_device,
    )

    result = get_location_data_for_device(canonic_id, name)
    if not result:
        log.info("No location returned for %s (%s) — likely not seen by the network recently", name, canonic_id)
        return None

    # Upstream may return a single location or a list of historical fixes;
    # take the most recent one we can parse.
    locations = result if isinstance(result, (list, tuple)) else [result]
    parsed = [f for f in (_normalize_location(canonic_id, name, l) for l in locations) if f]
    if not parsed:
        return None
    parsed.sort(key=lambda f: f.timestamp)
    return parsed[-1]


def _maybe_float(v: Any) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _to_iso(ts: Any) -> str:
    """Coerce a timestamp (epoch seconds/ms or ISO string) to ISO 8601 UTC."""
    from datetime import datetime, timezone

    if isinstance(ts, str):
        return ts
    try:
        secs = float(ts)
    except (TypeError, ValueError):
        return str(ts)
    # Heuristic: values past ~year 2001 in ms are > 1e12.
    if secs > 1e12:
        secs /= 1000.0
    return datetime.fromtimestamp(secs, tz=timezone.utc).isoformat()
