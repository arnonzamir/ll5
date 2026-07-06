# DECISION-024 — WhatsApp ingest via RabbitMQ + self-healing webhook

Status: accepted — 2026-07-06 (built + deployed same day, in response to a live outage)

## Context

On 2026-07-06 ~09:07 Jerusalem, WhatsApp — ~90% of inbound message volume —
stopped reaching LL5 for ~2 hours while every other channel (Slack/SMS/Gmail)
kept flowing. Root cause chain:

1. Evolution's webhook for the `ll5` instance was configured `webhookBase64: true`
   (a default re-applied during the 2026-07-04 two-instance-trap re-pair). This
   inlines the full media file, base64-encoded, into the webhook JSON body.
2. A media message produced a body over the gateway's `express.json({ limit: '1mb' })`
   cap → the gateway returned **413 PayloadTooLargeError**.
3. Evolution retried the same oversized payload **10×** with backoff. Its webhook
   delivery is **serial per instance**, so the poison payload **head-of-line
   blocked** every message behind it — including tiny text messages that would
   have passed fine. By 09:17 the queue was fully jammed.
4. The inlined base64 was **never used**: the gateway fetches media separately
   via `getBase64FromMediaMessage`. So `webhookBase64: true` was pure harm.
5. The `WhatsAppFlowMonitor` didn't surface it — its flat 2h staleness window
   hadn't tripped when the user noticed.

Three distinct weaknesses: a synchronous, HOL-blocking transport; a config that
silently reverts to a harmful default on every re-pair; and a monitor blind to
short-but-total, channel-specific outages.

## Decision

**1. Decouple ingestion with RabbitMQ (broker in the gateway's own stack).**
Evolution keeps its webhook, but the gateway ingress verifies the secret,
resolves instance→user, **publishes to RabbitMQ, and 200s immediately**. A worker
consumes and dispatches at its own pace. A poison/slow message can no longer
block the feed — it retries via a TTL queue and, after `MAX_ATTEMPTS`, parks in a
dead-letter queue while everything else flows.

Topology (durable): exchange `whatsapp` (direct) → `whatsapp.ingest` (worker);
`whatsapp.retry` (TTL 15s, dead-letters back to ingest); `whatsapp.dlq` (terminal).

The broker lives in the **ll5 stack** (same docker network as the gateway), NOT
cross-stack. The gateway and the wa-search Evolution are on isolated Coolify
networks bridged only by the public webhook URL; standing a broker between them
would require joining both stacks to a shared network and restarting the shared
Evolution — fragile on this box's history. Evolution → fast-ack webhook → Rabbit
gets the same durability/isolation with zero cross-stack surgery and no change to
wa-search. (Considered and rejected: Evolution publishing natively to RabbitMQ.)

**2. Never a hard dependency.** If `RABBITMQ_URL` is unset or the broker is
unreachable, `publish()` returns false and the ingress processes **inline** (the
pre-existing behaviour). The queue is a resilience layer, not a new SPOF.

**3. Self-healing webhook config.** The gateway reconciles each mapped instance's
Evolution webhook to the desired shape — `base64: false`, the shared secret
header, and the full event list — so a re-paired instance's default config can
never re-create the 413 jam. Two triggers: event-driven on
`connection.update→open` / `application.startup` (uses the instance's own key),
and a periodic scheduler using the Evolution **global** key (closes the
cold-start gap: a freshly re-paired instance whose per-instance key we don't yet
hold still gets fixed). Idempotent — only POSTs on drift.

**4. Connection lifecycle → agent awareness.** `connection.update`,
`application.startup`, `logout.instance`, `remove.instance`, `qrcode.updated` now
update the account's `status`/`last_seen`/`last_error` and, on transitions into or
out of a down state, raise/clear an alert and proactively engage the agent so it
can tell the user "WhatsApp dropped / needs a QR scan / reconnected." Gated on
transitions to avoid flap spam.

**5. Cross-channel early alerting.** `WhatsAppFlowMonitor` now also fires when
WhatsApp has been silent >45m **while another channel was seen <20m ago** — a
WhatsApp-specific outage caught in ~45m instead of the flat 2h window.

## Alternatives considered

- **Just raise the body limit.** Fixes 413 but not HOL blocking, and keeps a
  wasteful base64 payload flowing.
- **Webhook 200-fast + Redis list** (lighter tier). ~90% of the benefit reusing
  existing Redis, but the user explicitly chose a real broker with proper
  ack/nack + DLQ semantics.
- **Evolution publishes natively to RabbitMQ.** Purest decoupling, rejected for
  the cross-stack networking + shared-Evolution-restart risk (see Decision 1).

## Consequences

- New `rabbitmq` service (512M cap) in the ll5 stack; new env `RABBITMQ_URL`,
  `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `WHATSAPP_WEBHOOK_PUBLIC_URL`.
- Media handling is unchanged (already fetched separately), so `base64:false` is
  safe.
- Ingestion is now at-least-once. `processWhatsAppWebhook` is made idempotent by
  a stable ES doc id derived from `userId + key.id` plus an early existence check
  that skips a redelivery entirely (no duplicate message, media, or agent ping).
  (Corrected 2026-07-06 after review: the processor was NOT previously idempotent
  — it used a random doc id, so a retry would have duplicated. See Addendum 3.)
- `EVOLUTION_API_KEY` (global) must be injected via the deploy pipeline (Coolify
  API env does not sync to the on-host `.env` for CI-deployed services).
- The DLQ is a new operational surface — the flow monitor's suggestion now points
  at `whatsapp.dlq` for poison-message triage.

## Addendum 2 (2026-07-06, evening) — dedicated in-stack Evolution

Diagnosing why the dashboard's WhatsApp buttons all failed uncovered the real
mess: the number `972528836099` was linked as a WhatsApp device across **two
separate Evolution deployments** — ll4's (`evolution.noninoni.click` →
`api-as4wows…`, instance `ll4_account_20`) and ll5's (the internal wa-search
`evolution-i0okcoo…`, instance `ll5` + several `was_*` archive links). That's
3–4 active linked devices on one number, at/over WhatsApp's cap — the real cause
of the flapping and `No session found to decrypt` (sessions evicted/rotated).
And ll5's messaging MCP pointed `EVOLUTION_API_URL` at `evolution.noninoni.click`
= **ll4's** Evolution, which has no `ll5` instance → every dashboard call 404'd.

**Fix (chosen by the user): a dedicated Evolution for ll5, in the ll5 stack.**
New `evolution` service (`evoapicloud/evolution-api:v2.3.7`) on the ll5 network,
DB = the `evolution` database on ll5 postgres, local cache (no redis). Reached
**internally** at `http://evolution:8080` by BOTH the messaging MCP and the
gateway — so the dashboard works AND the gateway reconciler works (internal, no
public-URL 404). No public domain, no cross-stack coupling. One clean device
link. Global key = `EVOLUTION_GLOBAL_KEY` (GH secret, injected to `.env`). The
fresh `ll5` instance is provisioned here with `base64:false`; the old ghost `ll5`
on the wa-search Evolution is deleted to free the device slot.

## Addendum 3 (2026-07-06) — fixes from an independent review

An adversarial review of the whole change surfaced real issues; fixed:
- **Idempotency (was the biggest hole):** the message ES doc id was a random
  UUID → an at-least-once retry/redelivery would duplicate the message, re-download
  media, and double-ping the agent. Now a stable id from `userId + key.id` + an
  early `es.exists` skip (`whatsapp-webhook.ts`). +tests.
- **Residual 413:** the global 1MB body cap 413s *before* the queue runs, so a
  large non-media event (big CONTACTS/CHATS sync) could still HOL-block. The
  `/webhook/whatsapp` route now parses at 10MB (`server.ts`).
- **Queue arg-drift lockout:** a 406 PRECONDITION_FAILED (durable queue exists
  with different args) used to loop silently → permanent inline fallback. Now
  logged LOUD as a topology conflict (`whatsapp-queue.ts`).
- **Robustness:** consumer-channel rejections caught (no unhandledRejection);
  reconnect timer cleared on close; migration 006 pre-cleans duplicate
  `instance_name` rows before ADD CONSTRAINT.
- **Coverage:** added `whatsapp-queue.test.ts` (retry→DLQ, max-attempts, undecodable
  →DLQ, publish-false fallback) + an idempotency case. 657 gateway tests.

## Addendum (2026-07-06, verified on deploy)

- **RabbitMQ pipeline verified live:** broker healthy, gateway connected as a
  consumer (`whatsapp.ingest` 1 consumer; `whatsapp.retry`/`whatsapp.dlq`
  present), reconnect-backoff proven (gateway started before the broker, retried,
  connected), env injected. The head-of-line-block outage class is eliminated.
- **The gateway-side reconciler can't reach Evolution's admin API.** The gateway
  is on an isolated network and reaches Evolution only via the **public** URL,
  which does NOT expose `/webhook/find` or `/webhook/set` (both 404; only the
  internal container IP works — 201). So the periodic/event-triggered reconcile
  from the gateway is a **no-op safety net**, not the enforcement point.
- **Enforcement moved to instance-create (messaging MCP, the domain owner).**
  `EvolutionClient.createInstance` now sets `webhook.base64:false` + the full
  event list (incl `APPLICATION_STARTUP`/`LOGOUT_INSTANCE`) at provision time.
  Since a re-pair = logout (deletes the instance) + reconnect (`/instance/create`,
  which IS publicly reachable), this is exactly the path that must not revert to
  base64:true — and it no longer can. Regression test in
  `messaging/__tests__/evolution-client.test.ts`.
