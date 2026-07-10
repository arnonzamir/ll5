# DECISION-026 — Per-user opencode web console (subdomain + tenant-token forwardAuth)

Date: 2026-07-11
Status: Implemented (flag-gated; OFF until `CONSOLE_DOMAIN_BASE` is set)

## Context

We want to "show the running opencode session" from the dashboard. `opencode serve`
already ships a full web UI at `:4096/`, but it (a) has **no base-path option** and
loads assets from absolute root paths (`/assets/…`) — so it can't be proxied under a
gateway subpath — and (b) logs *"OPENCODE_SERVER_PASSWORD is not set; server is
unsecured."* Each user runs their own container (`ll5-agent-<uid>`), so we need a
per-user, authenticated way to reach that container's UI.

## Decision

Serve each user's console on its **own subdomain** `agent-<uid>.<CONSOLE_DOMAIN_BASE>`
(e.g. `agent-<uid>.noninoni.click`), routed by **Traefik docker labels** the
orchestrator stamps on the container at create time (same mechanism as the MCP
services). Because it's a dedicated origin, the opencode SPA's absolute asset paths
resolve correctly — no rewriting.

Authentication uses the **tenant LL5 token** end to end via a Traefik `forwardAuth`
middleware:
1. Dashboard "Open console" → `GET /me/agent/console/enter` (behind the tenant LL5
   token). The gateway mints a short-lived **console token** (HMAC over `{uid, exp}`,
   `AUTH_SECRET`) and returns `https://agent-<uid>.<base>/?ll5_console_token=<tok>`.
2. Browser opens that URL. Traefik's forwardAuth calls the gateway
   `GET /internal/console-auth` for every request. On the first hit it validates the
   `?ll5_console_token`, checks `token.uid === uid-in-host`, and returns `200` +
   `Set-Cookie: ll5_console=<tok>` (HttpOnly, Secure). Subsequent SPA requests carry
   the cookie; forwardAuth validates it. Anything else → `401`.

DNS/TLS: `*.noninoni.click` is already a Cloudflare wildcard (proxied; edge cert
covers one label), so `agent-<uid>.noninoni.click` resolves and terminates TLS with
no per-user DNS work. Traefik origin cert via the existing `letsencrypt` resolver.

Flag-gated: `CONSOLE_DOMAIN_BASE` empty ⇒ gateway `/console/enter` returns 503 and the
orchestrator emits **no** Traefik labels — zero change to prod until deliberately set.

## Alternatives considered

- **Proxy the SPA under `/me/agent/console/*`** — impossible cleanly: opencode uses
  absolute asset paths and has no base-path; would require brittle JS/HTML rewriting.
- **Custom read-only viewer** (proxy `/session` + `/event` SSE, render in-dashboard) —
  simpler and safe, but no interactive control; rejected in favor of the full UI.
- **`docker exec` PTY / xterm.js** — bigger security surface, redundant with `sess me`.

## Consequences

- Full interactive opencode UI per user, gated by the tenant LL5 token.
- The console token is console-scoped (HMAC, 8h) — not the full LL5 token — and lives
  only in an HttpOnly cookie on the console origin.
- **Follow-up hardening:** set `OPENCODE_SERVER_PASSWORD` on the container (defense in
  depth for the internal network) and teach `triggerAgent` + in-container self-calls to
  send it. Not required for the public path (forwardAuth gates it), so deferred.
- **Rollout risk:** touches Traefik. Verify Coolify's Traefik picks up labels on the
  (non-Coolify) orchestrator containers on the shared network before relying on it.
- Enable by setting `CONSOLE_DOMAIN_BASE=noninoni.click` on gateway + orchestrator,
  then re-provision a container so its labels are stamped.
