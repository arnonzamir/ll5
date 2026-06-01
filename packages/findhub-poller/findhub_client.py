"""
Adapter around GoogleFindMyTools (https://github.com/leonboe1/GoogleFindMyTools).

This is the ONLY module that touches the upstream library. It is isolated on
purpose: GoogleFindMyTools is an experimental, reverse-engineered project whose
internals change between commits. If a future version breaks, fix it HERE and
the rest of the poller is unaffected.

Why this drives upstream primitives instead of the convenient entry point:
GoogleFindMyTools' `get_location_data_for_device` (a) blocks FOREVER on an
untimed `while result is None` loop, and (b) only PRINTS the decrypted location
— it returns nothing. Neither is usable in a long-running poller. So we drive
the lower-level pieces ourselves:

  - request_device_list / parse_device_list_protobuf / get_canonic_ids  → device list
  - FcmReceiver + create_location_request + nova_request                → request a fix
  - (vendored) decrypt loop                                             → RETURN locations

The decrypt loop is copied from upstream's `decrypt_location_response_locations`
(which prints) and adapted to return structured data; it reuses upstream's
crypto helpers (retrieve_identity_key/decrypt/decrypt_aes_gcm) so we don't
reimplement any cryptography.

Verified against GoogleFindMyTools commit d46e952 (2026-06).
"""

import hashlib
import logging
import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("findhub.client")

# Per-device wait for a location push before giving up (trackers not seen by the
# network recently simply won't answer — we must not block the poll cycle).
LOCATE_TIMEOUT_SEC = float(os.environ.get("FINDHUB_LOCATE_TIMEOUT_SEC", "30"))


@dataclass
class DeviceFix:
    device_id: str
    name: str
    lat: float
    lon: float
    timestamp: str          # ISO 8601 UTC
    device_type: str = "unknown"
    accuracy_m: Optional[float] = None
    battery_pct: Optional[float] = None
    semantic_name: Optional[str] = None


# --- Device list -----------------------------------------------------------

def list_device_ids() -> list[tuple[str, str]]:
    """Return [(canonic_id, name), ...] for every device on the account."""
    from NovaApi.ListDevices.nbe_list_devices import request_device_list
    from ProtoDecoders.decoder import parse_device_list_protobuf, get_canonic_ids
    from SpotApi.UploadPrecomputedPublicKeyIds.upload_precomputed_public_key_ids import (
        refresh_custom_trackers,
    )

    result_hex = request_device_list()
    device_list = parse_device_list_protobuf(result_hex)
    try:
        refresh_custom_trackers(device_list)  # parity with upstream; best-effort
    except Exception as err:
        log.debug("refresh_custom_trackers failed (non-fatal): %s", err)

    # get_canonic_ids returns (device_name, canonic_id) tuples.
    pairs = get_canonic_ids(device_list)
    devices = [(cid, name) for (name, cid) in pairs if cid]
    log.info("Discovered %d device(s) on the account", len(devices))
    return devices


# --- Location request (FCM round-trip) -------------------------------------

_fcm_token: Optional[str] = None
_dispatcher_registered = False
# request_uuid -> {"event": threading.Event, "result": device_update | None}
_pending: dict = {}
_pending_lock = threading.Lock()


def _dispatcher(response) -> None:
    """Single persistent FCM callback; routes a response to its waiter by uuid."""
    from ProtoDecoders.decoder import parse_device_update_protobuf

    try:
        device_update = parse_device_update_protobuf(response)
        uuid = device_update.fcmMetadata.requestUuid
    except Exception as err:
        log.debug("Failed to parse FCM response: %s", err)
        return
    with _pending_lock:
        slot = _pending.get(uuid)
        if slot is not None:
            slot["result"] = device_update
            slot["event"].set()


def _ensure_listener() -> str:
    """Register our dispatcher with the singleton FcmReceiver exactly once."""
    global _fcm_token, _dispatcher_registered
    if not _dispatcher_registered:
        from Auth.fcm_receiver import FcmReceiver

        _fcm_token = FcmReceiver().register_for_location_updates(_dispatcher)
        _dispatcher_registered = True
    return _fcm_token


def get_device_fix(canonic_id: str, name: str) -> Optional[DeviceFix]:
    """Request the latest decrypted location for one device. None if unavailable."""
    from NovaApi.ExecuteAction.LocateTracker.location_request import create_location_request
    from NovaApi.nova_request import nova_request
    from NovaApi.scopes import NOVA_ACTION_API_SCOPE
    from NovaApi.util import generate_random_uuid

    token = _ensure_listener()
    request_uuid = generate_random_uuid()
    event = threading.Event()
    with _pending_lock:
        _pending[request_uuid] = {"event": event, "result": None}

    try:
        hex_payload = create_location_request(canonic_id, token, request_uuid)
        nova_request(NOVA_ACTION_API_SCOPE, hex_payload)
        if not event.wait(LOCATE_TIMEOUT_SEC):
            log.info(
                "No location for %s (%s) within %ss — likely not seen by the network recently",
                name, canonic_id, LOCATE_TIMEOUT_SEC,
            )
            return None
        with _pending_lock:
            device_update = _pending[request_uuid]["result"]
    finally:
        with _pending_lock:
            _pending.pop(request_uuid, None)

    try:
        locations = _decrypt_to_locations(device_update)
    except SystemExit:
        # Upstream calls exit(1) when a tracker's E2EE key can't be decrypted
        # (owner key rotated). Don't let that kill the poller.
        log.error("Decryption refused for %s (%s) — owner key mismatch? Skipping", name, canonic_id)
        return None
    except Exception as err:
        log.exception("Failed to decrypt locations for %s (%s): %s", name, canonic_id, err)
        return None

    return _build_fix(canonic_id, name, locations)


def _build_fix(canonic_id: str, name: str, locations: list[dict]) -> Optional[DeviceFix]:
    """Pick the most recent coordinate report; attach a semantic label if present."""
    coords = [l for l in locations if "lat" in l and "lon" in l]
    semantic = next((l for l in locations if l.get("semantic_name")), None)

    if not coords:
        if semantic:
            log.info("%s has only a semantic report (%s), no coordinates — skipping", name, semantic["semantic_name"])
        return None

    coords.sort(key=lambda l: l["time"])
    latest = coords[-1]
    return DeviceFix(
        device_id=canonic_id,
        name=name,
        lat=latest["lat"],
        lon=latest["lon"],
        timestamp=datetime.fromtimestamp(latest["time"], tz=timezone.utc).isoformat(),
        accuracy_m=float(latest["accuracy"]) if latest.get("accuracy") else None,
        semantic_name=semantic["semantic_name"] if semantic else None,
    )


# --- Vendored decrypt loop (adapted from upstream to RETURN, not print) -----

def _decrypt_to_locations(device_update) -> list[dict]:
    """Decrypt a device-update protobuf into a list of location dicts.

    Mirrors GoogleFindMyTools' decrypt_location_response_locations() but returns
    the data instead of printing it. Reuses upstream crypto helpers verbatim.
    """
    from NovaApi.ExecuteAction.LocateTracker.decrypt_locations import (
        retrieve_identity_key,
        is_mcu_tracker,
    )
    from FMDNCrypto.foreign_tracker_cryptor import decrypt
    from KeyBackup.cloud_key_decryptor import decrypt_aes_gcm
    from ProtoDecoders import DeviceUpdate_pb2, Common_pb2

    info = device_update.deviceMetadata.information
    device_registration = info.deviceRegistration
    identity_key = retrieve_identity_key(device_registration)
    is_mcu = is_mcu_tracker(device_registration)

    reports = info.locationInformation.reports.recentLocationAndNetworkLocations
    net_locations = list(reports.networkLocations)
    net_times = list(reports.networkLocationTimestamps)
    if reports.HasField("recentLocation"):
        net_locations.append(reports.recentLocation)
        net_times.append(reports.recentLocationTimestamp)

    out: list[dict] = []
    for loc, t in zip(net_locations, net_times):
        if loc.status == Common_pb2.Status.SEMANTIC:
            out.append({
                "semantic_name": loc.semanticLocation.locationName,
                "time": int(t.seconds),
            })
            continue

        # Decrypt per-report defensively: a single bad report (e.g. the known
        # InvalidTag on some phone "own reports", upstream issue #22) must not
        # discard the device's other, good reports.
        try:
            encrypted = loc.geoLocation.encryptedReport.encryptedLocation
            public_key_random = loc.geoLocation.encryptedReport.publicKeyRandom
            if public_key_random == b"":  # own report
                decrypted = decrypt_aes_gcm(hashlib.sha256(identity_key).digest(), encrypted)
            else:
                time_offset = 0 if is_mcu else loc.geoLocation.deviceTimeOffset
                decrypted = decrypt(identity_key, encrypted, public_key_random, time_offset)

            proto_loc = DeviceUpdate_pb2.Location()
            proto_loc.ParseFromString(decrypted)
        except Exception as err:
            log.debug("Skipping an undecryptable report (status=%s): %s", loc.status, err)
            continue

        out.append({
            "lat": proto_loc.latitude / 1e7,
            "lon": proto_loc.longitude / 1e7,
            "altitude": proto_loc.altitude,
            "time": int(t.seconds),
            "accuracy": loc.geoLocation.accuracy,
            "is_own": loc.geoLocation.encryptedReport.isOwnReport,
        })
    return out
