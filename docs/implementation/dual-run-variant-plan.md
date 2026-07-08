# Dual Run-Variant Plan (v2 — Post-Review)

## Goal

Restructure the ll5 ecosystem so that **ll5** (this repo) builds and deploys one of two agent runtime variants:

- **ll5-run-claude-code** — renamed from `ll5-run`, the existing Claude Code client
- **ll5-run-opencode** — new parallel repo using opencode + Zen

Both variants deploy on the existing Coolify infrastructure. The MCP servers, gateway, dashboard, and all infrastructure are unchanged — only the agent container and its client wrapper differ.

---

## Review Summary

Three parallel reviews (architecture, CI/CD, risk/feasibility) identified **15 critical/major issues** in v1. This v2 incorporates all fixes. Key changes from v1:

| v1 gap | Source | v2 fix |
|---|---|---|
| Channel bridge called "~300 lines" — actually 1748 | All 3 reviews | Dedicated bridge-replacement sub-plan with per-responsibility mapping |
| Listed 6 hooks — actually ~16 | Arch + Feasibility | Full hook inventory with port/drop/N-A classification |
| Referenced `ll5` launcher — production uses `ll5-server` supervisor | Arch + Feasibility | Corrected to ll5-server; opencode equivalent specified |
| Missing `external-authority-gate` (security-critical) | Arch + Feasibility | P0 plugin in opencode variant |
| Missing `grounding-reviewer` subagent | Arch | Added to both variants |
| Metadata lost in triggerAgent | Arch | Full metadata payload in trigger |
| Correlation-id propagation (DECISION-012) unaddressed | Feasibility | Header injection mechanism specified |
| No fail-fast gate | Feasibility | New Phase 2.5: thin vertical slice |
| Image naming mismatch (`ll5-ll5-run-claude` vs `ll5-run-claude`) | CI/CD | Matrix packages named `run-claude`/`run-opencode` |
| Node build steps crash for variant packages | CI/CD | Skip conditions added |
| `OPENCODE_SESSION_ID` bootstrap gap | CI/CD + Feasibility | Agent registration endpoint |
| Standalone→compose transition undefined | CI/CD | New Phase 4.5: explicit transition |
| $HOME persistence missing | Arch | Persistent volume for `$HOME` |
| Claude Code healthcheck broken (no HTTP server) | Arch + CI/CD | Variant-specific healthcheck |
| Port 4096 published to host | Arch + CI/CD | Removed — internal only |
| Timeline 2.5 weeks — actually ~5-6 | Feasibility | Corrected to 5-6 weeks |
| "All tests unchanged" — false | Feasibility | 2 test files need updates |
| Reconcile worker security model unaddressed | Feasibility | Allowlist verification + security test port |
| Worker session routing unaddressed | Feasibility | Per-worker session mapping |
| Behavioral parity rated High/Medium — should be High/High | Feasibility | Re-rated; persona tuning phase added |

---

## Current State

```
ll5 (this repo)         → builds MCPs + gateway + dashboard, deploys via CI
ll5-run (separate repo) → builds agent container via its own CI, deployed separately on host
ll5-android (separate)  → Android app, no agent dependency
```

- The agent container is **not** in `docker-compose.prod.yml`. It is a separate Coolify app (UUID `js8owk0g0cgog800ckc8ww0s`) with its own compose, its own image (`ghcr.io/arnonzamir/ll5-agent:latest`), and its own workspace volume.
- `build-and-push.yml` builds 9 packages, pushes to GHCR, deploys via SSH.
- The deploy job pulls only infrastructure images. It does not touch the agent container.
- The gateway triggers the agent implicitly: `insertSystemMessage` writes to PG, PG NOTIFY fires, the channel bridge in ll5-run picks it up and injects into Claude Code.
- The agent runs `ll5-server` (not `ll5`) — a supervisor loop that pre-warms MCP connections, gathers live context for the opening prompt, and relaunches `claude --continue` when `mcp-autoheal-server.sh` kills it for an in-place MCP reconnect.
- The channel bridge (`ll5-channel.mjs`) is ~1748 lines handling SSE reconnection, priority notification throttle queue, turn-context tracking, posted-ledger dedup, MCP health probing, conversation unification, token refresh, 409 retry, reaction forwarding, display_compact, thinking indicators, and `[LL5]`-prefix enforcement.
- The ll5-run repo has ~16 hooks (not 6), including the security-critical `external-authority-gate.sh`.
- Correlation-id headers (`X-LL5-Session-Id`, `X-LL5-Trace-Id`) are injected via `get-mcp-auth.sh` and read by all MCPs for the audit ledger (DECISION-012), the reconcile governor's `wrong_close_count` (DECISION-025), and the eval cassette.

## Target State

```
ll5 (this repo)              → builds MCPs + gateway + dashboard + AGENT VARIANT, deploys all
ll5-run-claude-code (repo)   → Claude Code variant content (hooks, channel, supervisor, workers)
ll5-run-opencode (repo)      → opencode variant content (plugins, SDK workers, config)
ll5-android (separate)       → unchanged
```

- The agent container **is** in `docker-compose.prod.yml`, parameterized by `AGENT_VARIANT`.
- `build-and-push.yml` builds infrastructure packages + the selected agent variant.
- The deploy job pulls the agent image and includes it in `docker compose up -d`.
- The gateway triggers the agent explicitly: `insertSystemMessage` writes to PG (unchanged for dashboard/audit), then calls `triggerAgent()` which is either a no-op (Claude Code: NOTIFY→channel bridge still works) or an HTTP call (opencode: `POST /session/:id/prompt_async`) with full message metadata.
- Switching variants = change `AGENT_VARIANT` in the on-host `.env`, deploy.

---

## Architecture: Shared vs Variant-Specific

### Shared content (lives in ll5, under `packages/ll5-run-shared/`)

Both variants use identical:

| Content | Current location | New location |
|---|---|---|
| `CLAUDE.md` (persona, 14 Hard Rules, GTD coaching) | ll5-run root | `packages/ll5-run-shared/CLAUDE.md` |
| `.claude/skills/*/SKILL.md` (17 skills) | ll5-run `.claude/skills/` | `packages/ll5-run-shared/skills/` |
| `prompts/narrative-loop.md` | ll5-run `prompts/` | `packages/ll5-run-shared/prompts/narrative-loop.md` |
| `prompts/reconcile-loop.md` | ll5-run `prompts/` | `packages/ll5-run-shared/prompts/reconcile-loop.md` |
| MCP endpoint definitions (6 remote MCPs, URLs, auth) | ll5-run `.mcp.server.json` | `packages/ll5-run-shared/mcp-endpoints.json` (source of truth) |

Rationale: this content is coupled to the MCP servers' tool sets. If a tool changes, the persona and skills must update. Versioning them with the MCP servers (in ll5) is architecturally correct.

**Note on MCP config rendering**: The source-of-truth (`mcp-endpoints.json`) defines endpoints + auth. Each variant renders it differently:
- Claude Code: `.claude/settings.json` with `headersHelper` pointing to `get-mcp-auth.sh` (emits Bearer + correlation-id headers, reads token from `~/.ll5/token`)
- opencode: `opencode.json` `mcp` section with `headers` (static Bearer; correlation-id injection via plugin — see below)
- Workers: restricted configs (`.mcp.reconcile.json`, `.mcp.narrate.json`) → opencode per-agent permissions

The rendering step is a CI script (`scripts/render-mcp-config.ts`) that reads `mcp-endpoints.json` and emits variant-specific files. This is non-trivial glue, not a COPY.

### Variant-specific content

**ll5-run-claude-code** (renamed from ll5-run, after extracting shared content):

| Content | Purpose |
|---|---|
| **Hooks** (~16, see full inventory below) | PreToolUse, UserPromptSubmit, Stop, SessionStart, PostToolUse |
| `channel/ll5-channel.mjs` (~1748 lines) | SSE chat bridge: reliability layer between Claude Code stdio and gateway PG |
| `scripts/narrative-loop.sh` | Headless `claude -p` background worker |
| `scripts/reconcile-loop.sh` | Headless `claude -p` reconcile worker |
| `scripts/mcp-autoheal-server.sh` | MCP health watcher → kill claude on recovery edge → supervisor relaunches |
| `scripts/continuity-probe.sh` | Grades compact re-grounding payload |
| `scripts/reconnect-mcps.sh` | MCP reconnection logic |
| `scripts/watchdog/*.sh` | Process monitoring + session backup |
| `scripts/transcribe.py` | Voice note transcription |
| `scripts/evals/live_eval.py` | Eval infrastructure |
| `ll5-server` (supervisor, NOT `ll5` launcher) | Supervisor loop: pre-warm MCPs, gather opening context, relaunch `claude --continue` on autoheal kill, source OAuth from 0600 env-file |
| `.claude/agents/narrative-consolidator.md` | Subagent: batch narrative consolidation |
| `.claude/agents/grounding-reviewer.md` | Subagent: durable forward-facing work verification (Hard Rule 12) |
| `.mcp.reconcile.json` | Restricted MCP set for reconcile worker (4-tool allowlist) |
| `.mcp.narrate.json` | Restricted MCP set for narrate worker |
| `docker-entrypoint.sh` | Starts tmux + ll5-server + channel bridge + loop scripts + autoheal |
| `tmux.conf` | PTY config for Claude Code (requires terminal) |

**ll5-run-opencode** (new repo):

| Content | Purpose |
|---|---|
| **Plugins** (~12, see full inventory below) | tool.execute.before, session.created, experimental.session.compacting, message events |
| `.opencode/agents/narrative-consolidator.md` | Same subagent, opencode format |
| `.opencode/agents/grounding-reviewer.md` | Same subagent, opencode format |
| `.opencode/agents/reconcile-worker.md` | Reconcile worker (restricted via per-agent permissions — allowlist, not denylist) |
| `scripts/narrative-loop.ts` | SDK-based: createOpencodeClient → session.create → session.prompt |
| `scripts/reconcile-loop.ts` | SDK-based: restricted agent, security-tested |
| `scripts/autoheal.ts` | SDK-based: MCP health watch → session restart (only if opencode doesn't retry HTTP MCPs natively — **validate in Phase 2.5**) |
| `scripts/continuity-probe.ts` | SDK-based session continuity grading |
| `scripts/session-backup.ts` | SDK-based session backup to ES |
| `scripts/render-mcp-config.ts` | Renders mcp-endpoints.json → opencode.json (CI step) |
| `opencode.json` | MCP servers, agent configs, permissions, model selection |
| `docker-entrypoint.sh` | Starts `opencode serve` + worker scripts + session registration |

### Full hook inventory

| # | Hook | Type | Claude Code | opencode plugin | Priority |
|---|---|---|---|---|---|
| 1 | `cron-block.sh` | PreToolUse | Deny CronCreate | `cron-block.ts` — deny scheduling tools (opencode equivalent TBD in Phase 2.5) | P1 |
| 2 | `repo-write-block.sh` | PreToolUse | Deny writes to workspace | `repo-write-block.ts` — same | P1 |
| 3 | `memory-intercept.sh` | PreToolUse | Intercept write/edit → ingest_memory → deny | `memory-intercept.ts` — tool.execute.before, same logic | P0 (Phase 2.5) |
| 4 | `external-authority-gate.sh` | PreToolUse | **Deny state-changing tools on externally-triggered turns** (Hard Rule 13) | `external-authority-gate.ts` — tool.execute.before, same safe-tool allowlist | **P0 — security-critical** |
| 5 | `stop-mirror.sh` | Stop | Surface agent prose, dedup via posted-ledger | `stop-mirror.ts` — session.idle event, dedup logic | P1 |
| 6 | `memory-recall.sh` | UserPromptSubmit | Inject recall_lessons before model sees prompt | SDK injection: chat bridge calls recall_lessons, prepends as noReply context | P1 |
| 7 | `session-start.sh` | SessionStart | Re-grounding (narratives + sessions + knowledge + lessons + journal; source=compact branch) | `session-start.ts` — session.created event, same re-grounding logic | P1 |
| 8 | `session-save.sh` | Stop + SessionEnd | POST session-so-far to `/sessions` → ES `ll5_session_history` (DECISION-012) | `session-history.ts` — message.updated with turn-boundary dedup (NOT message.part.updated — granularity mismatch) | P0 (Phase 2.5) |
| 9 | `eval-record.sh` | Stop | curl telemetry/eval-moment per turn | `eval-recorder.ts` — session.idle event (NOT message.part.updated — fires multiple times per turn), turn-boundary dedup | P2 |
| 10 | `activity-marker.sh` | PostToolUse | Live compact activity rows | `activity-marker.ts` — tool.execute.after, allowlist | P2 |
| 11 | `narration-watchdog.sh` | PostToolUse | Narrative loop liveness | `narration-watchdog.ts` — tool.execute.after | P2 |
| 12 | `cli-input-mirror.sh` | UserPromptSubmit | Mirror genuine CLI typing (never stdout) | N/A — opencode's TUI is different; may not need this | Drop with justification |
| 13 | `check-token.sh` | SessionStart | Token validity check | `session-start.ts` handles this (calls gateway auth) | Merged into #7 |
| 14 | `precompact-backup.sh` | PreCompact | Pre-compact session backup | `precompact-backup.ts` — experimental.session.compacting, backup before compaction | P1 |
| 15 | `file-changed.sh` | PostToolUse | File change tracking | `file-changed.ts` — tool.execute.after | P2 |
| 16 | `get-mcp-auth.sh` | headersHelper | Emit Bearer + correlation-id headers (X-LL5-Session-Id, X-LL5-Trace-Id) | **`correlation-id-injector.ts`** — plugin that injects headers into MCP tool calls via SDK; or opencode header config if supported. **Critical for DECISION-012 audit ledger + reconcile governor.** | **P0 — Phase 2.5** |

### Gateway changes (in ll5, variant-agnostic)

The gateway code is **identical for both variants**. Only the environment differs.

**New file: `packages/gateway/src/utils/agent-trigger.ts`**

```typescript
// When OPENCODE_SERVER_URL is set (opencode variant): HTTP POST to opencode server.
// When empty (Claude Code variant): no-op (the existing PG NOTIFY → channel bridge flow handles delivery).
// This is the ONLY variant-specific code path in the gateway, and it's env-driven.

interface TriggerPayload {
  content: string;
  metadata?: {
    source?: SourceRoutingMeta;      // platform, remote_jid, sender_name, contact_name, person_id, from_me, is_group, group_name
    scheduler?: SchedulerEventMeta;  // scheduler name, event_id, fired_at
  };
  noReply?: boolean;
}

export async function triggerAgent(
  sessionId: string | null,
  payload: TriggerPayload,
): Promise<void> {
  const url = process.env.OPENCODE_SERVER_URL;
  if (!url || !sessionId) return; // Claude Code variant — no-op

  try {
    await fetch(`${url}/session/${sessionId}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text: payload.content }],
        ...(payload.noReply ? { noReply: true } : {}),
        // Metadata is injected as a noReply context part BEFORE the content
        // so the agent sees source routing the same way the channel bridge delivered it.
        ...(payload.metadata ? {
          context: [{
            type: "text",
            text: `[meta] ${JSON.stringify(payload.metadata)}`,
          }],
        } : {}),
      }),
    });
  } catch (err) {
    logger.warn("[agent-trigger] Failed to trigger opencode session", { error: ... });
    // Do NOT swallow silently — track for retry (see redelivery below)
    throw err;
  }
}
```

**Modified: `packages/gateway/src/utils/system-message.ts`**

Add `triggerAgent` call after the PG insert. The PG insert + NOTIFY + FCM all stay. The trigger call is additive and passes full metadata:

```typescript
// At the end of insertSystemMessage, after the PG insert succeeds:
if (messageId && process.env.OPENCODE_SERVER_URL) {
  void triggerAgent(
    await getAgentSessionId(pool, userId),  // reads from user_settings.agent_session_id (not env)
    {
      content: fullContent,
      metadata: { source: sourceRouting, scheduler: schedulerEvent },
    },
  ).catch((err) => {
    // Redelivery: mark the PG row for retry by the stuck-message-sweep
    // (which already re-notifies lost pending rows — it now also calls triggerAgent)
    logger.warn("[agent-trigger] Trigger failed — row will be re-notified by sweep", { messageId, error: err });
  });
}
```

**Session registration (replaces static `OPENCODE_SESSION_ID` env var)**:

The agent container registers its session on startup via a new gateway endpoint:

```typescript
// New endpoint in gateway server.ts
app.post('/internal/agent-session', authMw, async (req, res) => {
  const userId = (req as any).userId;
  const { sessionId } = req.body;
  await pool.query(
    `UPDATE user_settings SET agent_session_id = $1 WHERE user_id = $2`,
    [sessionId, userId]
  );
  res.json({ ok: true });
});
```

The agent's `docker-entrypoint.sh` calls this on startup after creating the opencode session. `triggerAgent` reads `user_settings.agent_session_id` via `getAgentSessionId(pool, userId)`, not from env. This solves:
- The static env var bootstrap gap (agent can't modify gateway's env at runtime)
- Multi-tenant future (per-user session mapping)
- Session recreation on restart (agent re-registers)

**Migration**: `user_settings` already exists as a JSONB column store. Add `agent_session_id` as a nullable text column via a new migration (039).

**Worker session mapping**: The narrative-loop and reconcile-loop workers each create their own sessions. The gateway needs per-worker session routing. Approach:
- Workers register their sessions via the same `/internal/agent-session` endpoint with a `sessionType` field (`main`, `narrative-loop`, `reconcile-loop`)
- `user_settings` stores a JSON map: `agent_sessions: { main: "uuid", narrative_loop: "uuid", reconcile_loop: "uuid" }`
- Schedulers that target specific workers (narrative-consolidation → narrative-loop) read the appropriate session

**Modified: `packages/gateway/src/scheduler/stuck-message-sweep.ts`**

Pass A (re-notify lost pending rows): currently re-emits PG NOTIFY. Add `triggerAgent` call alongside `pg_notify` so the opencode variant also gets re-notified. This serves as the redelivery mechanism — if the initial `triggerAgent` call failed, the sweep retries it.

**Test updates**: `system-message.test.ts` and `stuck-message-sweep.test.ts` need `fetch` stubs / `triggerAgent` mocks to avoid network calls when `OPENCODE_SERVER_URL` leaks from env. **2 test files updated, rest unchanged.**

**No changes to any other gateway code.** All schedulers, monitors, alerting, webhook processors, REST endpoints, admin, approvals, vault, chat — unchanged. They all go through `insertSystemMessage` which now optionally triggers the agent.

---

## Channel Bridge Replacement Sub-Plan

The channel bridge (`ll5-channel.mjs`, ~1748 lines) is not just outbound tools — it's a **stateful reliability layer** between an unreliable stdio agent process and a durable PG-backed chat system. opencode's HTTP server model eliminates some concerns (no stdio process management) but others need faithful ports.

### Per-responsibility mapping

| Bridge responsibility | Lines | opencode equivalent | Effort |
|---|---|---|---|
| **Inbound SSE listener** (gateway `/chat/listen` → inject into session) | ~200 | **Eliminated.** Gateway calls `POST /session/:id/prompt_async` directly. No SSE listener needed. | 0 |
| **Priority notification throttle queue** (user vs. system, 5s spacing, drop-oldest-system) | ~150 | **Gateway-side.** Move throttling into `agent-trigger.ts` before the HTTP call. Queue + priority + spacing in the gateway, not the agent. | ~80 lines TS |
| **Turn-context tracking** (`expects_user_reply` per inbound) | ~100 | **opencode plugin** (`turn-context.ts`): track on `message.updated`, write to shared state file (`/workspace/.ll5/turn-context.json`). Used by stop-mirror. | ~50 lines TS |
| **Posted-ledger dedup** (`posted-this-turn.jsonl` — explicit replies don't double-post) | ~80 | **opencode plugin** (`stop-mirror.ts`): session.idle event, read posted-ledger, skip if already posted. Shared state file. | ~60 lines TS |
| **MCP health probing** (6 remote MCPs every 10min → `channel-health.json`) | ~120 | **opencode plugin** (`mcp-health.ts`): `check_mcp_connectivity` as a custom tool + periodic probe via SDK `client.app.agents()`. Or: gateway's existing mcp-health-monitor already does this server-side. | ~40 lines TS (or use existing gateway monitor) |
| **Conversation unification** (active-conv routing, 30s grace, 409 retry) | ~100 | **Eliminated for opencode.** opencode sessions are single-conversation. The gateway's chat conversation management is unaffected (it manages PG rows, not agent sessions). | 0 |
| **Token refresh** (atomic tmpfile+rename, 6 header readers) | ~80 | **opencode SDK handles auth.** opencode manages its own provider tokens. No manual refresh needed. | 0 |
| **409 retry on archived writes** | ~50 | **Eliminated.** opencode doesn't write to PG chat directly — it calls gateway REST via plugin tools. Gateway handles 409s. | 0 |
| **Reaction forwarding** | ~40 | **Plugin tool** (`react` in `ll5-channel.ts`): calls gateway `PATCH /chat/messages/:id`. | ~15 lines TS |
| **`display_compact` passthrough** | ~30 | **Plugin tool** (`narrate` in `ll5-channel.ts`): calls gateway `POST /chat/messages` with `display_compact: true`. | ~15 lines TS |
| **Thinking indicators** (`metadata.kind="thinking"`) | ~30 | **Plugin tool** (`narrate` in `ll5-channel.ts`): same metadata. | Merged above |
| **`[LL5]`-prefix enforcement gate** | ~40 | **Already in messaging MCP** (`checkLl5Prefix` in `utils/ll5-prefix.ts`). Agent-agnostic. | 0 |
| **Outbound tools** (push_to_user, narrate, react, new_conversation, check_mcp_connectivity) | ~200 | **opencode plugin** (`ll5-channel.ts`): 5 custom tools calling gateway REST. | ~80 lines TS |
| **Correlation-id header injection** (`get-mcp-auth.sh` → X-LL5-Session-Id, X-LL5-Trace-Id) | ~60 | **opencode plugin** (`correlation-id-injector.ts`): inject headers into MCP tool calls. **Critical for DECISION-012 audit ledger + reconcile governor.** If opencode doesn't support dynamic headers per MCP call, build a shim. | ~40 lines TS (or shim) |

**Total opencode-side new code: ~380 lines TS** (vs. 1748 lines .mjs). The reduction is real but significant — most of the bridge's complexity (SSE listener, conversation unification, token refresh, 409 retry) is eliminated by opencode's HTTP server model. The remaining stateful concerns (throttle, turn-context, dedup, correlation-ids) need faithful ports.

---

## Docker

### New Dockerfiles in ll5

**`docker/Dockerfile.ll5-run-claude`**

```dockerfile
FROM node:20-slim AS base

# Install Claude Code CLI + tmux (Claude Code requires a PTY)
RUN apt-get update && apt-get install -y tmux wget && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code

# Copy shared content from ll5 repo (build context)
COPY packages/ll5-run-shared/CLAUDE.md /workspace/CLAUDE.md
COPY packages/ll5-run-shared/skills/ /workspace/.claude/skills/
COPY packages/ll5-run-shared/prompts/ /workspace/prompts/

# Copy variant-specific content (checked out to variant-content/ by CI)
COPY variant-content/hooks/ /workspace/.claude/hooks/
COPY variant-content/channel/ /workspace/channel/
COPY variant-content/scripts/ /workspace/scripts/
COPY variant-content/ll5-server /workspace/ll5-server
COPY variant-content/tmux.conf /workspace/tmux.conf
COPY variant-content/.claude/agents/ /workspace/.claude/agents/
COPY variant-content/.mcp.reconcile.json /workspace/.mcp.reconcile.json
COPY variant-content/.mcp.narrate.json /workspace/.mcp.narrate.json
COPY variant-content/docker-entrypoint.sh /workspace/docker-entrypoint.sh
COPY variant-content/scripts/get-mcp-auth.sh /workspace/scripts/get-mcp-auth.sh

# Render MCP config from shared source-of-truth
RUN npx tsx scripts/render-mcp-config.ts --format claude --output /workspace/.claude/settings.json

# Persistent $HOME for Claude Code onboarding bypass, token, turn-context, posted-ledger
ENV HOME=/data/home
RUN mkdir -p /data/home

WORKDIR /workspace
RUN chmod +x /workspace/ll5-server /workspace/docker-entrypoint.sh /workspace/scripts/*.sh /workspace/scripts/get-mcp-auth.sh

ENTRYPOINT ["/workspace/docker-entrypoint.sh"]
```

**`docker/Dockerfile.ll5-run-opencode`**

```dockerfile
FROM node:20-slim AS base

# Install opencode CLI
RUN npm install -g opencode-ai@<PINNED_VERSION>
RUN apt-get update && apt-get install -y wget && rm -rf /var/lib/apt/lists/*

# Copy shared content from ll5 repo
COPY packages/ll5-run-shared/CLAUDE.md /workspace/CLAUDE.md
COPY packages/ll5-run-shared/skills/ /workspace/.claude/skills/
COPY packages/ll5-run-shared/prompts/ /workspace/prompts/

# Copy variant-specific content
COPY variant-content/.opencode/ /workspace/.opencode/
COPY variant-content/scripts/ /workspace/scripts/

# Render MCP config into opencode.json format
RUN npx tsx scripts/render-mcp-config.ts --format opencode --output /workspace/opencode.json

# Install plugin dependencies
COPY variant-content/.opencode/package.json /workspace/.opencode/package.json
RUN cd /workspace/.opencode && npm install --production

# Persistent $HOME for opencode state, session data
ENV HOME=/data/home
RUN mkdir -p /data/home

WORKDIR /workspace
RUN chmod +x /workspace/scripts/*.ts

EXPOSE 4096
ENTRYPOINT ["/workspace/docker-entrypoint.sh"]
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
```

### Compose changes: `docker/docker-compose.prod.yml`

```yaml
  # ---------- Agent (variant-selectable) ----------
  agent:
    <<: *defaults
    image: ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT:-claude}:latest
    container_name: agent-xkkcc0g4o48kkcows8488so4
    environment:
      NODE_ENV: production
      TZ: ${TZ:-Asia/Jerusalem}
      API_KEY: ${API_KEY}
      USER_ID: ${USER_ID}
      GATEWAY_URL: http://gateway:3000
      MCP_BASE_DOMAIN: ${MCP_BASE_DOMAIN:-noninoni.click}
      # Claude Code variant (subscription OAuth, NOT API key)
      CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}
      # opencode variant
      OPENCODE_ZEN_API_KEY: ${OPENCODE_ZEN_API_KEY:-}
    volumes:
      # Variant-specific workspace (not shared — stale state on switch)
      - agent-workspace-${AGENT_VARIANT:-claude}:/workspace
      # Persistent $HOME (onboarding bypass, token, turn-context, posted-ledger)
      - agent-home:/data/home
    # NO ports published — internal Docker network only (gateway reaches http://agent:4096)
    depends_on:
      gateway:
        condition: service_healthy
    deploy:
      resources:
        limits:
          memory: 1024M
          cpus: "1.0"
    healthcheck:
      # Variant-specific: entrypoint writes a /health probe script
      test: ["CMD-SHELL", "/workspace/healthcheck.sh"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 45s
    labels:
      # Prevent Coolify from auto-exposing the agent
      - "traefik.enable=false"
```

Volumes:
```yaml
  agent-workspace-claude:
    name: xkkcc0g4o48kkcows8488so4_agent-workspace-claude
  agent-workspace-opencode:
    name: xkkcc0g4o48kkcows8488so4_agent-workspace-opencode
  agent-home:
    name: xkkcc0g4o48kkcows8488so4_agent-home
```

Gateway env additions:
```yaml
      # Agent trigger (opencode variant only; empty = Claude Code NOTIFY flow)
      # Derived from AGENT_VARIANT in deploy script — not set independently
      OPENCODE_SERVER_URL: ${OPENCODE_SERVER_URL:-}
```

The `OPENCODE_SERVER_URL` is set to `http://agent:4096` when `AGENT_VARIANT=opencode`, empty when `AGENT_VARIANT=claude`. This is derived in the deploy script (not a separate env var) to make rollback truly single-var:

```bash
# In deploy script:
if [ "$AGENT_VARIANT" = "opencode" ]; then
  OPC_URL="http://agent:4096"
else
  OPC_URL=""
fi
# Idempotent upsert into .env (same pattern as ELASTIC_PASSWORD)
```

**Variant-specific healthcheck**: The entrypoint writes `/workspace/healthcheck.sh` on startup:
- Claude Code: `pgrep -f "claude" > /dev/null && pgrep -f "ll5-channel" > /dev/null` (process-based — no HTTP server)
- opencode: `wget -qO- http://localhost:4096/health` (HTTP — opencode server has built-in health)

---

## CI/CD

### `build-and-push.yml` changes

#### 1. Package naming (fixes image name mismatch)

Matrix packages are named `run-claude` and `run-opencode` (not `ll5-run-claude`) so the image tag becomes `ghcr.io/arnonzamir/ll5-run-claude:latest` (correct).

#### 2. Node build step skip conditions (fixes CI crash)

```yaml
      - name: Set up Node.js
        if: matrix.package != 'findhub-poller' && !startsWith(matrix.package, 'run-')
        uses: actions/setup-node@v4
        # ... same for npm ci, build shared, typecheck, build target
```

#### 3. Variant repo checkout (fixes PAT scope)

```yaml
      - uses: actions/checkout@v4  # ll5 repo (default)

      - name: Checkout variant repo
        if: startsWith(matrix.package, 'run-')
        uses: actions/checkout@v4
        with:
          repository: arnonzamir/ll5-${{ matrix.package }}-code
          path: variant-content
          token: ${{ secrets.VARIANT_REPO_READ_PAT }}  # NOT GHCR_READ_PAT — needs repo scope
```

#### 4. Dockerfile selection

```yaml
      - name: Determine Dockerfile
        id: dockerfile
        run: |
          case "${{ matrix.package }}" in
            run-claude)
              echo "file=docker/Dockerfile.ll5-run-claude" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            run-opencode)
              echo "file=docker/Dockerfile.ll5-run-opencode" >> "$GITHUB_OUTPUT"
              echo "build_args=" >> "$GITHUB_OUTPUT" ;;
            # ... existing cases unchanged ...
          esac
```

#### 5. Deploy job: pull agent image + inject all env vars

```bash
# In the deploy script:
AGENT_VARIANT=${AGENT_VARIANT:-claude}

# Derive OPENCODE_SERVER_URL from variant (not independent)
if [ "$AGENT_VARIANT" = "opencode" ]; then
  OPC_URL="http://agent:4096"
else
  OPC_URL=""
fi

# Idempotent upsert of AGENT_VARIANT + OPENCODE_SERVER_URL (same pattern as ELASTIC_PASSWORD)
touch .env
grep -v -E '^(AGENT_VARIANT|OPENCODE_SERVER_URL)=' .env > .env.agent.tmp 2>/dev/null || true
mv .env.agent.tmp .env
{
  printf 'AGENT_VARIANT=%s\n' "$AGENT_VARIANT"
  printf 'OPENCODE_SERVER_URL=%s\n' "$OPC_URL"
} >> .env

# Pull agent image
docker pull ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT}:latest 2>/dev/null || true

# Agent health check after compose up
docker compose ps agent | grep -q "Up" || echo "::error::Agent container not running"
```

All new secrets injected via the same idempotent pattern:
- `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code variant auth — subscription, not API key)
- `OPENCODE_ZEN_API_KEY` (opencode variant model access)
- `AGENT_VARIANT` (variant selection)

#### 6. Variant repo triggered rebuilds

Same as v1 (`repository_dispatch`) with two additions:
- **Weekly scheduled fallback**: a cron `workflow_dispatch` that rebuilds both variants unconditionally (catches failed dispatches).
- **`VARIANT_REPO_READ_PAT`** used for checkout (not `GHCR_READ_PAT`).

#### 7. repository_dispatch triggers full deploy

Documented behavior: variant repo pushes trigger `docker compose up -d` (only agent container recreates in steady state). Acceptable. A "build-only" dispatch type can be added if this becomes noisy.

---

## Phased Migration

**This is a single-user system at demo state.** No gradual rollouts, no alternating-day comparisons, no 24-hour monitoring. Switch, use it, fix what breaks.

### Phase 0: Rename ll5-run to ll5-run-claude-code

1. Rename the git repo on GitHub: `ll5-run` → `ll5-run-claude-code`
2. Update local remotes
3. Update any references in ll5 docs (FILE_TREE.md, HANDOFF.md, PROGRESS.md)
4. Update the ll5-run-claude-code CI to push images as `ghcr.io/arnonzamir/ll5-run-claude:latest`
5. Pull new image on the host, swap container, retire old image name
6. Update `LL5_DISPATCH_PAT` / `VARIANT_REPO_READ_PAT` scopes for the new repo name
7. **Done when Claude Code loads** — not full functional verification, just starts up

### Phase 1: Extract shared content to ll5

1. Create `packages/ll5-run-shared/` in ll5
2. Move from ll5-run-claude-code:
   - `CLAUDE.md` → `packages/ll5-run-shared/CLAUDE.md`
   - `.claude/skills/*/SKILL.md` (17 skills) → `packages/ll5-run-shared/skills/`
   - `prompts/*.md` → `packages/ll5-run-shared/prompts/`
   - `.mcp.server.json` → `packages/ll5-run-shared/mcp-endpoints.json`
3. **Audit CLAUDE.md and skills for path references** to ll5-run-specific locations. Update references.
4. Create `scripts/render-mcp-config.ts` — renders `mcp-endpoints.json` into Claude Code and opencode formats
5. Update ll5-run-claude-code to reference shared content (CI copies, not symlinks)
6. Add `ll5-run-shared` to change-detection in `build-and-push.yml`
7. Keep fallback copy until verified, then delete
8. **Verify**: Claude Code agent still loads with content sourced from ll5

### Phase 2: Gateway agent-trigger abstraction

1. Create `packages/gateway/src/utils/agent-trigger.ts` (with full metadata payload)
2. Add migration 039: `user_settings.agent_session_id` + `agent_sessions` JSONB
3. Add `POST /internal/agent-session` endpoint (session registration)
4. Add 5 thin `/internal/*` helper endpoints (ingest-memory, regrounding, activity, continuity-probe, memory-intercept-log, recall-lessons)
5. Modify `insertSystemMessage` to call `triggerAgent` when `OPENCODE_SERVER_URL` is set
6. Modify `stuck-message-sweep` pass A to call `triggerAgent` alongside `pg_notify`
7. **Update 2 test files**: `system-message.test.ts` + `stuck-message-sweep.test.ts`
8. Deploy gateway with `OPENCODE_SERVER_URL` empty — **Claude Code variant unaffected**

### Phase 2.5: Thin vertical slice — FAIL FAST GATE (1 hour)

Build a minimal opencode slice — memory-intercept plugin, push_to_user tool, correlation-id proxy, session-history plugin, probe script. Run it against the live remote MCPs for **1 hour**. Validate:
- (a) `tool.execute.before` deny semantics work
- (b) Events fire at the right granularity (turn boundary, not mid-turn)
- (c) Correlation-id headers land in the audit log
- (d) `prompt_async` queues correctly
- (e) opencode's MCP retry behavior (native or needs autoheal)
- (f) `experimental.session.compacting` fires
- (g) `session.created` fires
- (h) One skill (`/daily`) executes acceptably

**If a critical assumption fails**: stop. Phases 0-2 are still net-positive. No further opencode effort sunk.

**If it passes**: proceed to Phase 3.

### Phase 3: Create ll5-run-opencode repo

1. Create the repo on GitHub
2. Port 17 plugins (5 P0, 7 P1, 5 P2) with full TypeScript code
3. Port 5 SDK worker scripts (narrative-loop, reconcile-loop, autoheal, continuity-probe, session-backup)
4. Create `opencode.json` with MCP config, agent configs, permissions, model selection
5. Create 3 agent definitions (narrative-consolidator, grounding-reviewer, reconcile-worker)
6. Create `docker-entrypoint.sh` (starts `opencode serve` + proxy + workers + session registration)
7. Create `healthcheck.sh`
8. Add CI workflow: `trigger-ll5-rebuild.yml` (repository_dispatch to ll5)
9. **Verify locally**: run opencode with remote MCPs, execute skills, confirm tool calls work, confirm correlation-ids land in audit ledger

### Phase 4: Dockerfiles + CI

1. Create `docker/Dockerfile.ll5-run-claude` in ll5 (tmux, ll5-server, $HOME persistence)
2. Create `docker/Dockerfile.ll5-run-opencode` in ll5 (pinned opencode version, tsx, $HOME persistence)
3. Extend `build-and-push.yml`: variant packages, skip conditions, variant checkout, dispatch handler, weekly fallback
4. Add GitHub secrets: `AGENT_VARIANT`, `OPENCODE_ZEN_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VARIANT_REPO_READ_PAT`, `LL5_DISPATCH_PAT`
5. **Verify**: both images build and push to GHCR

### Phase 4.5: Standalone→compose transition

1. `docker stop` + `docker rm` the old standalone agent container
2. Migrate workspace data to the new compose-managed volume
3. Decommission the old Coolify app (`js8owk0g0cgog800ckc8ww0s`)
4. Verify only one agent container exists
5. Deploy with `AGENT_VARIANT=claude` — confirm agent works inside compose

### Phase 5: Compose + deploy opencode variant

1. Add `agent` service to `docker/docker-compose.prod.yml` (parameterized, no published ports, persistent $HOME, variant-specific healthcheck, `traefik.enable=false`)
2. Add env var injection to deploy script (AGENT_VARIANT, OPENCODE_SERVER_URL derived from it, CLAUDE_CODE_OAUTH_TOKEN, OPENCODE_ZEN_API_KEY)
3. Add agent image to deploy pull loop + health check
4. Deploy with `AGENT_VARIANT=opencode`
5. **Verify**: server starts, session registers, triggers reach agent, MCP tools work, a skill executes, push_to_user reaches gateway, external-authority-gate blocks state-changing tools on external turns, workers complete a cycle, session-history writes to ES

### Phase 6: Switch and use it

1. Set `AGENT_VARIANT=opencode`, deploy
2. Use it
3. If it breaks in a way that matters: set `AGENT_VARIANT=claude`, deploy — rollback is one env var change
4. Tune persona/skills for the opencode model as issues surface — no separate tuning phase, just fix what breaks

---

## What Does NOT Change

| Component | Why |
|---|---|
| All MCP servers (personal-knowledge, gtd, awareness, google, messaging, health, vault, system) | Standard HTTP+SSE MCP, agent-agnostic |
| Gateway REST endpoints (/chat, /auth, /admin, /approvals, /vault, /uploads) | Agent-agnostic |
| Gateway schedulers (logic) | Their logic is unchanged; only the trigger mechanism at the bottom changes (and only for opencode) |
| Gateway monitors | Read PG/ES, never call the agent directly |
| Gateway alerting | raiseAlert/clearAlert write to PG + FCM |
| Gateway webhook processors (logic) | Processing logic unchanged; trigger is additive |
| All Postgres migrations (000-038) | Schema unchanged. New migration 039 (agent_session_id) is additive |
| All ES indices | Unchanged |
| Dashboard | Talks to gateway REST/SSE |
| ll5-android | Talks to gateway REST/SSE |
| Docker infra (ES, PG, RabbitMQ, Evolution, browser) | Unchanged |
| Coolify | Same service UUID, same network, same Traefik |
| All tests (except 2) | `system-message.test.ts` + `stuck-message-sweep.test.ts` updated; rest unchanged |
| build-and-push.yml (infra packages) | Unchanged for existing 9 packages; only extended |
| compose-drift-check | Unchanged |

---

## Risk Assessment

**Single-user demo system.** Risks are real but impact is bounded — one user, no SLA, instant rollback.

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| opencode model interprets persona differently | High | Medium | Fix what breaks as it surfaces; no parity testing phase |
| Correlation-id injection fails on opencode | Medium | High | Phase 2.5 validates in 1 hour; proxy sidecar fallback |
| external-authority-gate doesn't block | Medium | High | Phase 2.5 validates deny semantics; fail-closed default |
| opencode plugin API differs from docs | Medium | Medium | Phase 2.5 probe script validates event names |
| Agent container in compose changes deploy behavior | Low | Low | Phase 4.5 explicit transition |
| Silent failure (agent up but not triggering) | Medium | Medium | Stuck-message-sweep pass B flips loudly after 30min |
| Rollback needed | Medium | Low | One env var change + deploy |

---

## Estimated Timeline

**Single-user demo system.** No gradual rollouts, no parity testing weeks. Build, switch, fix what breaks.

| Phase | Duration | Can overlap? |
|---|---|---|
| 0: Rename | 1 hour | No |
| 1: Extract shared content | 1-2 days | Yes (with Phase 2) |
| 2: Gateway agent-trigger | 1 day | Yes (with Phase 1) |
| **2.5: Thin vertical slice (FAIL FAST)** | **1 hour** | **No (depends on 2)** |
| 3: Create ll5-run-opencode | 1 week | Yes (with Phases 1-2) |
| 4: Dockerfiles + CI | 1-2 days | No (depends on 1, 3) |
| **4.5: Standalone→compose transition** | **1 hour** | **No (depends on 4)** |
| 5: Compose + deploy opencode | 1 day | No (depends on 4.5) |
| 6: Switch and use it | immediate | No (depends on 5) |

**Total elapsed time: ~2 weeks** (with overlap in Phases 1-3).

**Fail-fast gate**: Phase 2.5 (1 hour) validates the core assumption before 1 week of build. If it fails, Phases 0-2 are still net-positive and no further opencode effort is sunk.
