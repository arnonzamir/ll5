# findhub-poller

Python sidecar that polls the **Google Find Hub** (Find My Device) network via
[GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) and pushes
each device/tracker location to the LL5 gateway as `tracked_device` webhook
items.

It locates **things** (Bluetooth tags on keys/bag/car, ESP32 trackers) and
**other devices** shared to the Google account (a partner's phone, a tablet) —
distinct from the user's own GPS, which already flows from the phone app. The
gateway reverse-geocodes and place-matches each fix and upserts it into the
`ll5_awareness_tracked_devices` index; the awareness MCP exposes it via the
`get_tracked_devices` and `where_is_device` tools.

This is the only Python in the LL5 stack — see
[`docs/decisions/DECISION-008`](../../docs/decisions/DECISION-008-findhub-python-sidecar.md)
for why it's a sidecar rather than a TypeScript port.

## One-time auth (requires Chrome, done locally)

GoogleFindMyTools authenticates through a browser the first time and stores the
result in `Auth/secrets.json`. The container does **not** run Chrome — you
generate the file on a desktop and bring it in.

1. On a machine with Chrome:
   ```bash
   git clone https://github.com/leonboe1/GoogleFindMyTools.git
   cd GoogleFindMyTools
   pip install -r requirements.txt
   python main.py        # complete the Google login; this writes Auth/secrets.json
   ```
2. Keep `Auth/secrets.json` safe — it grants access to your Find Hub data. It
   can expire; if the poller starts failing auth, regenerate it and redeploy.

## Run locally

```bash
cp .env.example .env          # fill in gateway URL + ll5 token
docker build -t ll5-findhub-poller .
docker run --rm --env-file .env \
  -v /abs/path/to/Auth:/opt/GoogleFindMyTools/Auth \
  ll5-findhub-poller
```

## Configuration

See [`.env.example`](.env.example). Required: `LL5_GATEWAY_WEBHOOK_URL`,
`LL5_WEBHOOK_TOKEN`. The token is the user's `ll5.<...>` auth token — it scopes
every pushed device to that tenant.

## Caveats

- **Experimental upstream.** GoogleFindMyTools is reverse-engineered and can
  break when Google changes the network. All library calls are isolated in
  [`findhub_client.py`](findhub_client.py); fix breakage there. The adapter
  skips (with a loud log) any device it can't confidently parse rather than
  emitting a bogus `0,0` fix.
- **Patchy freshness.** A tracker's location only updates when a nearby Android
  device on the network sees it. Stale fixes are expected; the awareness tools
  surface `freshness` / `age_minutes` so the agent can judge.
- **Rate.** Default poll is 15 min. Don't drop below ~5 min.
- **Cloudflare.** The poller sets an explicit `User-Agent`; the gateway is
  behind Cloudflare, which 403s the default Python UA.
