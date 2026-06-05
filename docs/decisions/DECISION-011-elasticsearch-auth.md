# DECISION-011: Enable Elasticsearch authentication

## Context

Elasticsearch ran with `xpack.security.enabled=false` — no auth — on the shared
internal Docker network. It is not publicly exposed (no published port, no
Traefik), so the exposure was in-network only. But when we gave the agent a
browser (DECISION-010), an unauthed ES on the same network became an acute SSRF
target: a prompt-injected page could drive the browser to read or wipe all user
data via `http://elasticsearch:9200`. We mitigated that at the browser
(`--blocked-origins`), but an unauthed datastore is a latent risk on its own
(any compromised in-network container can read/write everything).

## Decision

**Enable ES security (basic auth required), no TLS.** `xpack.security.enabled=true`
with `http.ssl`/`transport.ssl` disabled — ES is internal-only, so plaintext on
the private network is acceptable, and `discovery.type=single-node` exempts
transport TLS.

**Wire every client via inline credentials in `ELASTICSEARCH_URL`** =
`http://elastic:${ELASTIC_PASSWORD}@elasticsearch:9200`. The `@elastic/elasticsearch`
client (awareness, personal-knowledge, google, health, gateway) parses basic auth
from the node URL — **zero code change**. The dashboard talks to ES via raw
`fetch` (which ignores URL userinfo), so a small `lib/es.ts` helper strips the
creds for the base URL and sends them as an `Authorization: Basic` header.

**Password handling:** `ELASTIC_PASSWORD` is a GitHub Actions secret, injected
into the on-host `.env` by the deploy job (Coolify env doesn't reach compose
interpolation — same pattern as the findhub secrets). On existing ES data,
`ELASTIC_PASSWORD` env does NOT bootstrap the user, so the `elastic` password is
set post-deploy via `elasticsearch-reset-password` + the `_password` API to match
the secret.

## Alternatives considered

- **API keys / dedicated service users + roles.** More principled (least
  privilege per service), but more moving parts. Single shared `elastic` superuser
  is acceptable for a one-tenant personal system; can tighten later.
- **TLS on the HTTP/transport layer.** Unnecessary on an internal-only,
  single-node cluster; adds cert management. Skipped.
- **Network isolation instead of auth** (dedicated browser network, or ES off the
  shared net). Awkward under Coolify's shared-Traefik topology; auth is the
  cleaner root-cause fix and helps against *any* in-network actor, not just the
  browser.

## Consequences

- All ES-backed services now authenticate. A brief all-MCP downtime occurred
  during the secure-restart + password-bootstrap window (health-monitor may have
  fired transient "MCP down" alerts).
- New ops surface: the `ELASTIC_PASSWORD` GitHub secret + on-host `.env` injection;
  bootstrap via `reset-password` after first secure start (see HANDOFF).
- **Rollback:** set `xpack.security.enabled=false` in the compose + redeploy
  (clients ignore the inline creds when ES doesn't require them).
- Follow-up: consider per-service API keys with scoped roles instead of the shared
  superuser.
