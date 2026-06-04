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
- `--isolated` = ephemeral profile (no persisted logins) for v1 safety; persistent
  per-user storage-state is a later addition when we need authenticated sessions.
- **Security follow-ups (tracked, not in v1):** SSRF hardening via an egress
  allowlist / `--blocked-origins` for RFC1918 + the cloud metadata IP; a
  navigation allowlist; and treating all extracted page text as untrusted (never
  let it silently trigger privileged actions). basicAuth covers the control plane;
  these cover the data plane.
