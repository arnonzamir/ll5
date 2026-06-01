#!/usr/bin/env python3
"""
LL5 findhub-poller — polls the Google Find Hub (Find My Device) network via
GoogleFindMyTools and pushes each device/tracker location to the LL5 gateway as
`tracked_device` webhook items.

It locates THINGS (Bluetooth tags) and OTHER devices (shared phones/tablets),
NOT the user's own GPS — that already flows from the phone app. See
docs/design/findhub.md.

Config (environment):
  LL5_GATEWAY_WEBHOOK_URL   Full gateway webhook URL, e.g. https://<host>/webhook   (required)
  LL5_WEBHOOK_TOKEN         The ll5.<...> bearer token identifying the user        (required)
  FINDHUB_POLL_INTERVAL_SEC Seconds between polls. Default 900 (15 min).
  FINDHUB_DEVICE_TYPES      Optional JSON map {canonic_id_or_name: "tracker"|...}.
  LOG_LEVEL                 debug|info|warning|error. Default info.

Auth: GoogleFindMyTools reads its own Auth/secrets.json (generated once locally
with Chrome — see README). Mount/copy it into the container before first run.
"""

import json
import logging
import os
import sys
import time

import requests

import findhub_client as fh

# A custom UA is REQUIRED: the gateway sits behind Cloudflare, which 403s the
# default python-requests / urllib user agents (see the LL5 Cloudflare-403
# incident). Identify ourselves explicitly.
USER_AGENT = "ll5-findhub-poller/1.0"

log = logging.getLogger("findhub.poller")


def _env(name: str, required: bool = False, default: str | None = None) -> str | None:
    val = os.environ.get(name, default)
    if required and not val:
        log.error("Missing required environment variable: %s", name)
        sys.exit(2)
    return val


def _infer_device_type(canonic_id: str, name: str, override_map: dict) -> str:
    """Best-effort device-type classification. Explicit override wins."""
    if canonic_id in override_map:
        return override_map[canonic_id]
    if name in override_map:
        return override_map[name]
    lname = name.lower()
    if any(w in lname for w in ("phone", "pixel", "galaxy", "iphone", "oneplus")):
        return "phone"
    if any(w in lname for w in ("tab", "ipad")):
        return "tablet"
    if any(w in lname for w in ("watch", "band")):
        return "watch"
    if any(w in lname for w in ("tag", "key", "wallet", "bag", "car", "tracker", "chipolo", "pebblebee")):
        return "tracker"
    return "unknown"


def build_items(override_map: dict) -> list[dict]:
    """Poll the network and build gateway `tracked_device` items."""
    items: list[dict] = []
    for canonic_id, name in fh.list_device_ids():
        try:
            fix = fh.get_device_fix(canonic_id, name)
        except Exception as err:  # one bad device must not abort the whole batch
            log.exception("Failed to locate %s (%s): %s", name, canonic_id, err)
            continue
        if not fix:
            continue
        item = {
            "type": "tracked_device",
            "device_id": fix.device_id,
            "name": fix.name,
            "device_type": fix.device_type
            if fix.device_type != "unknown"
            else _infer_device_type(canonic_id, name, override_map),
            "timestamp": fix.timestamp,
            "lat": fix.lat,
            "lon": fix.lon,
        }
        if fix.accuracy_m is not None:
            item["accuracy_m"] = fix.accuracy_m
        if fix.battery_pct is not None:
            item["battery_pct"] = fix.battery_pct
        if fix.semantic_name:
            item["semantic_name"] = fix.semantic_name
        items.append(item)
    return items


def push_items(webhook_url: str, token: str, items: list[dict]) -> None:
    if not items:
        log.info("No locatable devices this cycle — nothing to push")
        return
    resp = requests.post(
        webhook_url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=json.dumps({"items": items}),
        timeout=30,
    )
    if resp.status_code != 200:
        # Surface, don't swallow (LL5 no-silent-errors rule).
        log.error("Gateway rejected push: HTTP %s — %s", resp.status_code, resp.text[:500])
        return
    body = resp.json()
    log.info(
        "Pushed %d device(s): accepted=%s failed=%s",
        len(items),
        body.get("accepted"),
        body.get("failed"),
    )
    if body.get("failed"):
        log.warning("Some items failed: %s", body.get("results"))


def main() -> None:
    logging.basicConfig(
        level=getattr(logging, (_env("LOG_LEVEL", default="info") or "info").upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    webhook_url = _env("LL5_GATEWAY_WEBHOOK_URL", required=True)
    token = _env("LL5_WEBHOOK_TOKEN", required=True)
    interval = int(_env("FINDHUB_POLL_INTERVAL_SEC", default="900") or "900")

    override_map: dict = {}
    raw_map = _env("FINDHUB_DEVICE_TYPES")
    if raw_map:
        try:
            override_map = json.loads(raw_map)
        except json.JSONDecodeError as err:
            log.error("FINDHUB_DEVICE_TYPES is not valid JSON: %s", err)

    log.info("findhub-poller starting: interval=%ss target=%s", interval, webhook_url)

    while True:
        started = time.monotonic()
        try:
            items = build_items(override_map)
            push_items(webhook_url, token, items)
        except Exception as err:
            # Catch-all so the loop survives transient upstream/auth failures.
            log.exception("Poll cycle failed: %s", err)
        elapsed = time.monotonic() - started
        sleep_for = max(5.0, interval - elapsed)
        log.debug("Cycle done in %.1fs; sleeping %.0fs", elapsed, sleep_for)
        time.sleep(sleep_for)


if __name__ == "__main__":
    main()
