# DECISION-010: Browser access via Playwright MCP (own container, Traefik basicAuth)

## Context

LL5's agent needs to *browse* — navigate pages, click, fill forms, log in, read
rendered content, screenshot — for tasks that plain HTTP fetching can't do. We
evaluated the 2026 landscape (Playwright MCP, the archived Puppeteer reference
server, Browserbase/Stagehand, Steel, browser-use, Skyvern, Anthropic's
first-party tools).

Constraints from LL5's architecture: MCPs are **remote HTTP/SSE services in Docker
behind Traefik** (principle #4), TypeScript/Node, Claude-driven, multi-tenant and
security-conscious. The agent reaches MCPs over **public HTTPS + a token** (it is
not on the MCP stack's internal Docker network).

## Decision

**1. Use Microsoft Playwright MCP (`@playwright/mcp`, image
`mcr.microsoft.com/playwright/mcp`) as a dedicated container in the ll5 stack,**
headless Chromium, exposed over streamable-HTTP at `/mcp`. It's official,
Apache-2.0, the most active option, TypeScript-native, headless-server-ready, and
Claude drives its deterministic accessibility-tree tools directly (snapshot /
click / type / fill / screenshot) — **no second model in the loop**.

**2. Front it with a Traefik `basicAuth` middleware** at
`mcp-browser.noninoni.click`. Playwright MCP has no built-in auth, and an open
browser-driver is the real risk (anyone could drive it → SSRF/exfil). basicAuth
locks the control plane to the agent (which holds the Basic credential). The
agent injects the header via a `headersHelper` script reading a creds file the
entrypoint writes from a Coolify env var — so no plaintext credential lands in git.

**3. Pair it with Anthropic's first-party `web_search` / `web_fetch`** for
read-only "look it up / read this page" tasks, so the real browser is reserved
for genuine interactive/authenticated flows — cheaper, safer, less attack surface.

## Alternatives considered

- **`@modelcontextprotocol/server-puppeteer`** — ARCHIVED May 2025, unmaintained,
  open SSRF/prompt-injection advisories. Rejected.
- **Browserbase/Stagehand MCP** — best ergonomics + managed anti-bot, but cloud
  egress of page data, per-session cost, a second model by default, and a
  documented prompt-injection advisory. Kept as a possible future secondary for
  hard anti-bot targets; **Steel** is the self-hosted equivalent if we want that
  without the cloud.
- **browser-use / Skyvern** — powerful but Python, local-desktop-oriented (or
  AGPL), need their own LLM key. Off-stack; weaker fit.
- **stdio child of the agent** (run `npx @playwright/mcp` inside the agent
  container). Simpler auth (no network), but bloats the flaky-to-deploy agent
  image with Chromium + apt deps and couples lifecycles. Rejected in favour of an
  isolated container that matches the "MCPs are remote HTTP services" principle
  and deploys via the reliable ll5-stack CI.

## Consequences

- New container `browser` in `docker/docker-compose.prod.yml`
  (`mcr.microsoft.com/playwright/mcp`, `--headless --no-sandbox --isolated`,
  `shm_size 1gb`, mem cap), routed by Traefik with a basicAuth middleware.
- Agent (`ll5-run`): a `browser` server in `.mcp.json` (`type:http`, headersHelper
  `get-browser-auth.sh`), `mcp__browser__*` allowed in `.claude/settings.json`,
  Basic creds via the `BROWSER_MCP_BASIC` env var (Coolify, not git).
- **Persistent login (added 2026-06-05):** dropped `--isolated`; the browser now
  uses `--user-data-dir /home/node/profile` on a bind-mounted, pre-chowned
  (uid 1000) host dir `/opt/ll5/browser-profile`, so cookies/logins survive
  restarts. Single shared profile — fine for the one-user system. (Bind mount,
  not a named volume, to avoid the root-owned-mountpoint perm trap; no custom
  image, stays non-root.)
- **SSRF hardening (added 2026-06-05, data plane):** `--blocked-origins` stops the
  browser from loading the cloud metadata IP **and the internal ll5 services**.
  The acute risk here is Elasticsearch — it runs UNAUTHED (`xpack.security.enabled
  =false`) on the same Docker network, so a prompt-injected page must not be able
  to reach `http://elasticsearch:9200`. Also `--block-service-workers`. basicAuth
  covers the control plane; this covers the data plane.
  - **Residual / future:** blocked-origins is host-based, so a *raw container IP*
    isn't covered (not enumerable here, but not zero). The stronger controls are
    (a) **put Elasticsearch behind auth**, and/or (b) a dedicated browser network
    isolated from the service network — both deferred (the latter is awkward under
    Coolify's shared-Traefik topology). Also still treat extracted page text as
    untrusted (never let it silently trigger privileged actions).
- The box (Hetzner dedicated) exposes no cloud metadata endpoint today (probe
  returned 000), but the metadata IP is blocked anyway as cheap defense-in-depth.
