# Runbook: rotate / set `WHATSAPP_WEBHOOK_SECRET`

This is the shared secret between Evolution API (sender) and the LL5 gateway (receiver) for `POST /webhook/whatsapp`. Without it set, the gateway refuses to start.

## When to run this

- First rollout of the WhatsApp webhook auth feature (Phase 1.2, 2026-05-18).
- Suspected leak of the current secret.
- Quarterly rotation as policy.

## Steps

### 1. Generate a new secret

```bash
openssl rand -hex 32
```

64-char hex string. Treat as a password — do not paste into chat, ticket trackers, or commit. Length validation in `packages/gateway/src/utils/env.ts` enforces `>= 32` chars.

### 2. Set the secret on the gateway in Coolify

1. Open Coolify → **Project** → **gateway** application.
2. **Environment Variables** tab → **+ Add**.
   - Key: `WHATSAPP_WEBHOOK_SECRET`
   - Value: *(paste the 64-char hex from step 1)*
   - Is Build Time: **off**
   - Is Runtime: **on**
3. Save. **Do not redeploy yet** — Evolution API needs the matching value first, otherwise it'll send unauthenticated webhooks during the gap and they'll all 401.

### 3. Set the same value on Evolution API

Evolution API can attach custom headers to its outbound webhooks in two ways. Use whichever your deployment uses:

**Global (recommended, all instances inherit):**

1. Open Coolify → Evolution API service → Environment Variables.
2. Add or update:
   - `WEBHOOK_GLOBAL_HEADERS` (JSON-string) — `{"X-Webhook-Secret":"<paste-the-same-value>"}`

   Some Evolution API versions use `WEBHOOK_HEADERS` instead. Check the running container's docs:
   ```bash
   ssh root@<server> 'docker exec <evolution-container> env | grep -i webhook'
   ```
3. Save & restart the Evolution API container.

**Per-instance (override):**

For each WhatsApp instance that posts to LL5:

```bash
curl -X POST 'https://<evolution-api>/webhook/set/<instance-name>' \
  -H 'apikey: <evolution-admin-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "enabled": true,
    "url": "https://gateway.noninoni.click/webhook/whatsapp",
    "headers": { "X-Webhook-Secret": "<paste-the-same-value>" },
    "events": ["MESSAGES_UPSERT", "CONTACTS_UPSERT", "CHATS_UPSERT", "CHATS_UPDATE"]
  }'
```

(Field names may differ slightly across Evolution API versions — match the schema the running version exposes at `/manager`.)

### 4. Redeploy the gateway

In Coolify → gateway → **Redeploy**. The new `WHATSAPP_WEBHOOK_SECRET` is picked up at process start; the deploy will fail-fast with a clear error if it's missing or under 32 chars.

### 5. Verify

From any machine that can reach `gateway.noninoni.click`:

```bash
# Should return 401 — header missing
curl -i -X POST https://gateway.noninoni.click/webhook/whatsapp \
  -H 'Content-Type: application/json' \
  -d '{"instance":"x","event":"messages.upsert","data":{}}'

# Should return 401 — wrong secret
curl -i -X POST https://gateway.noninoni.click/webhook/whatsapp \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: wrong' \
  -d '{"instance":"x","event":"messages.upsert","data":{}}'

# Should return 404 (unknown instance) — proves auth passed, fallback removed
curl -i -X POST https://gateway.noninoni.click/webhook/whatsapp \
  -H 'Content-Type: application/json' \
  -H 'X-Webhook-Secret: <the-real-secret>' \
  -d '{"instance":"definitely-not-a-real-instance","event":"messages.upsert","data":{}}'
```

Then watch real traffic in Coolify gateway logs:

```bash
# In Coolify → gateway → Logs
# Look for the WARN lines if anything is misconfigured:
#   [whatsappWebhook] Rejected: missing or invalid X-Webhook-Secret
#   [whatsappWebhook] Unknown instance
```

If you see either consistently after step 3 completes, the secrets don't match — re-paste and redeploy.

## Rollback

If something goes wrong:

1. **Symptom: gateway won't start.** `WHATSAPP_WEBHOOK_SECRET` is unset or too short. Re-add in Coolify env, redeploy.
2. **Symptom: all WhatsApp webhooks 401.** Mismatch between Evolution API headers and gateway env. Re-paste the same value on both sides.
3. **Symptom: webhooks 401 from one instance only.** That instance has a stale per-instance webhook config from before the global header was added. Re-run the per-instance `POST /webhook/set/...` curl from step 3.

There is no clean rollback to the no-auth state — that was the vulnerability. If you must, the only escape is reverting the gateway to a pre-Phase-1.2 image. Do not.

## Related

- `packages/gateway/src/whatsapp-webhook-route.ts` — the auth check (`safeEqual`).
- `packages/gateway/src/utils/env.ts:73` — the env var validation.
- `packages/gateway/src/__tests__/whatsapp-webhook-route.test.ts` — 10 tests covering the auth, the no-fallback rule, and event routing.
- `docs/PROGRESS.md` — Phase 1.2 entry.
