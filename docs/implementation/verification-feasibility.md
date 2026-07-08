# Feasibility Verification Report — Dual Run-Variant Migration

**Verifier**: pragmatic senior engineer (final feasibility pass)
**Date**: 2026-07-08
**Documents reviewed**: master plan v2, build-order (137 tasks), gateway plan (1554 lines), Docker/CI plan (1341 lines), security plan (1914 lines), opencode plan (2147 lines), testing plan (1417 lines)
**Ground truth verified against**: `system-message.ts`, `stuck-message-sweep.ts`, `server.ts`, `docker-compose.prod.yml`, migration 016/031, opencode plugin docs, opencode SDK docs

---

## Overall Verdict

**IMPLEMENTATION CANNOT BEGIN AS-IS.** 5 blocking issues must be fixed first. 7 significant issues need resolution before the relevant phase starts. The architecture is sound, the phased approach is well-designed, and most of the code is real (not pseudocode). But the blocking issues would cause compile failures, runtime crashes, or silent metadata loss if a developer followed the plans verbatim.

**Estimated fix effort**: 4-6 hours for blocking issues, 3-4 hours for significant issues.

---

## 1. Code Correctness

### 1.1 `agent-trigger.ts` — ISSUE FOUND (blocking)

**File**: `impl-gateway-shared.md` §2.1 (lines 624-681), `dual-run-variant-plan.md` (lines 168-211)

The `triggerAgent` function sends metadata via a `context` field in the `prompt_async` body:

```typescript
// impl-gateway-shared.md line 643
body.context = [
  { type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` },
];
```

The opencode variant plan §0.2 (line 63) explicitly corrects this:

> `SessionPromptAsyncData.body` has **no `context` field**. Only `parts`, `agent`, `noReply`, `system`, `tools`, `model`, `messageID`.

The opencode variant plan's `turn-context.ts` (§3.4.7, line 1282) scans `output.parts` for the `[meta]` marker:

```typescript
for (const part of output.parts) {
  if (part.type === "text" && typeof (part as any).text === "string") {
    const meta = parseMeta((part as any).text)
```

If the gateway sends metadata in `context` (which opencode ignores), the `turn-context.ts` plugin scanning `output.parts` will never find it. The `external-authority-gate.ts` reads `turn-context.json` (written by `turn-context.ts`), so the security gate would fail-closed on every turn (treating all turns as externally-triggered because the context file says `externally_triggered: false` but is stale, or the `[meta]` is never parsed).

**Fix**: Prepend the `[meta]` text as the first element of `parts` in `agent-trigger.ts`:

```typescript
const parts = [];
if (payload.metadata) {
  parts.push({ type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` });
}
parts.push({ type: 'text', text: payload.content });
body.parts = parts;
```

This must be fixed in both `impl-gateway-shared.md` §2.1 and `dual-run-variant-plan.md` lines 190-204.

### 1.2 `system-message.ts` modification — VERIFIED

**File**: `impl-gateway-shared.md` §2.4 (lines 855-1031)

Cross-checked against actual `packages/gateway/src/utils/system-message.ts` (160 lines):
- Import addition (`triggerAgent, getAgentSessionId`) — correct, follows existing import style
- Insertion point (after FCM block, before `return messageId`) — correct
- Fire-and-forget pattern via `void (async () => {...})()` — correct, doesn't block the PG insert return
- `fullContent` variable — exists in the actual code (line 104), used correctly
- `sourceRouting` and `schedulerEvent` params — exist in the actual function signature (lines 82-89)
- `.catch()` logging pattern — matches existing error handling style

The diff is accurate and would integrate cleanly. The only issue is the downstream `context` field problem (see §1.1).

### 1.3 Migration 039 SQL — VERIFIED

**File**: `impl-gateway-shared.md` §2.2 (lines 789-811)

Cross-checked against `migrations/016_user_settings.sql`:
- `user_settings` table exists with `user_id UUID PRIMARY KEY`, `settings JSONB`, `updated_at TIMESTAMPTZ`
- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` — idempotent, safe to re-run
- `agent_session_id TEXT` (nullable) — correct, no default needed
- `agent_sessions JSONB NOT NULL DEFAULT '{}'` — correct, existing rows get the default
- The UPSERT in the endpoint (lines 748-769) uses `INSERT ... ON CONFLICT DO UPDATE` with `jsonb_build_object` and `||` shallow-merge — syntactically correct PostgreSQL

The migration is the next number in sequence (038 exists, 039 is next). No conflict.

### 1.4 Dockerfiles — ISSUE FOUND (blocking)

**File**: `impl-docker-cicd.md` §4.1, §4.2

**Issue A — `--input` flag doesn't exist in render script**:

Dockerfile (line 79-82):
```dockerfile
RUN npx tsx /workspace/scripts/render-mcp-config.ts \
      --format claude \
      --input /workspace/mcp-endpoints.json \
      --output /workspace/.claude/settings.json
```

The render script (`impl-gateway-shared.md` §1.3, line 359) accepts `--config`, not `--input`:
```typescript
else if (arg.startsWith('--config')) configPath = v ?? configPath;
```

The `--input` flag is silently ignored. The script falls back to `packages/ll5-run-shared/mcp-endpoints.json` (the default), which doesn't exist in the Docker build context (the file was COPY'd to `/workspace/mcp-endpoints.json`). The build would fail with `MCP endpoints config not found`.

**Fix**: Change `--input` to `--config` in both Dockerfiles (lines 79-82, 175-178).

**Issue B — opencode.json render step overwrites the full config**:

Dockerfile (line 175-178):
```dockerfile
RUN npx tsx /workspace/scripts/render-mcp-config.ts \
      --format opencode \
      --output /workspace/opencode.json
```

The render script outputs only `{ "mcp": { ... } }` — no plugins, no agents, no permissions. This overwrites the hand-written `opencode.json` from `variant-content/.opencode/` (which has the full config with plugins, agents, permissions, proxy URLs). After the render step, the opencode.json would have only MCP servers and nothing else.

**Fix**: Either (a) render to a temp file and merge with the existing opencode.json, or (b) have the render script read the existing opencode.json and merge the MCP section into it, or (c) split MCP config into a separate file that opencode includes.

**Issue C — `.ts` scripts run as `.js`**:

`docker-entrypoint.sh` (§3.10, line 1961):
```bash
node /workspace/scripts/correlation-id-proxy.js &
```

But the scripts are TypeScript (`.ts`). The Dockerfile does `RUN chmod +x /workspace/scripts/*.ts` but has no compilation step. `node` cannot run TypeScript directly.

**Fix**: Either (a) add `RUN npx tsc` compilation step, or (b) change entrypoint to use `npx tsx /workspace/scripts/*.ts`, or (c) use `bun` to run `.ts` files directly (if Bun is installed — see §1.5 below).

### 1.5 Correlation-id proxy — ISSUE FOUND (blocking)

**File**: `impl-security.md` §3c (lines 1653-1707), `impl-opencode-variant.md` §2.5.5 (lines 450-472)

The proxy uses `Bun.serve()`:
```typescript
const server = Bun.serve({
  port: PROXY_PORT,
  ...
})
```

The Dockerfile uses `node:20-slim` and installs `opencode-ai` via `npm`. Bun is not installed. The entrypoint runs `node /workspace/scripts/correlation-id-proxy.js` — but `Bun` is not defined in Node.js. The proxy would crash immediately with `ReferenceError: Bun is not defined`.

**Fix**: Either (a) install Bun in the Dockerfile (`RUN npm install -g bun`), or (b) rewrite the proxy using Node.js's `http` module (no Bun dependency). Option (b) is safer — Bun may not be available for all base images. ~40 lines of Node.js `http.createServer` replaces the `Bun.serve` call.

---

## 2. opencode API Accuracy

### 2.1 Plugin API corrections — ISSUE FOUND (significant)

The opencode variant plan §0 correctly identifies that `session.created`, `session.idle`, `message.updated` are NOT direct hooks — they are Event types dispatched through the single `event` hook. Verified against [opencode plugin docs](https://opencode.ai/docs/plugins/): the `event` hook pattern `event: async ({ event }) => { if (event.type === "session.idle") {...} }` is correct.

However, the **security plan's `turn-context.ts`** (`impl-security.md` §1c, lines 455-514) uses the WRONG API:

```typescript
// WRONG — these are not direct hooks
"message.updated": async (event) => { ... },
"session.idle": async () => { ... },
```

The opencode variant plan's own `turn-context.ts` (§3.4.7, lines 1278-1311) correctly uses:
```typescript
// CORRECT — chat.message is a direct hook, session.idle goes through event
"chat.message": async (input, output) => { ... },
event: async ({ event }) => {
  if (event.type !== "session.idle") return
  ...
}
```

**Fix**: Update `impl-security.md` §1c `turn-context.ts` to match the opencode variant plan's version. The security plan's version won't load — opencode would ignore the `"message.updated"` and `"session.idle"` keys since they're not in the `Hooks` interface.

### 2.2 `tool.execute.before` signature — VERIFIED

The opencode variant plan §0.1 and the docs confirm: `tool.execute.before` receives `(input, output)` where `input.tool` is the tool name and `output.args` is the args. Deny = `throw new Error(...)`. The security plan's `external-authority-gate.ts` (§1c, line 377) uses `input.tool` — correct. The memory-intercept uses `output.args` — correct.

### 2.3 `chat.message` hook — ISSUE FOUND (needs Phase 2.5 validation)

The opencode variant plan §0.1 (line 37) lists `"chat.message"` as a direct hook. The opencode plugin docs do NOT list `chat.message` in the events list or the hooks documentation. The plan claims it's from the installed `@opencode-ai/plugin@1.17.15` types.

If `chat.message` doesn't exist at runtime, the `turn-context.ts` plugin's primary trigger (parsing `[meta]` from inbound messages) won't fire. The fallback would be using the `event` hook with `message.updated` type.

**Status**: Flagged for Phase 2.5 validation (g). Not blocking — the plan's Appendix C decision matrix already covers this case.

### 2.4 SDK methods — VERIFIED

Cross-checked against [opencode SDK docs](https://opencode.ai/docs/sdk/):
- `createOpencodeClient({ baseUrl })` — correct
- `client.session.create({ body: { title } })` — correct
- `client.session.prompt({ path: { id }, body: { parts, agent, noReply } })` — correct
- `client.session.messages({ path: { id } })` — correct (returns `{ info: Message, parts: Part[] }[]`)
- `client.session.delete({ path: { id } })` — correct
- `client.session.abort({ path: { id } })` — correct
- `client.session.list()` — correct
- `client.event.subscribe()` — correct (returns SSE stream; docs show `events.stream` property — the probe script's defensive `(chunk as any)?.data ?? chunk` handles both shapes)

### 2.5 `experimental.session.compacting` — VERIFIED

The docs confirm this is a direct hook: `"experimental.session.compacting": async (input, output) => { output.context.push(...) }`. The opencode variant plan's `compaction.ts` (§3.4.5) and `precompact-backup.ts` (§3.4.6) use this correctly.

---

## 3. Implementation Clarity

### 3.1 Task pick-up-ability — VERIFIED (with gaps)

A developer can pick up most tasks from the build-order and implement them using the impl plans. Each task has: description, effort, dependencies, acceptance criteria, and file references. The code examples are real implementation, not pseudocode (verified by cross-checking against the actual codebase).

**Gap**: Several opencode plugins call gateway endpoints that don't exist yet:

| Plugin | Endpoint called | Exists? |
|---|---|---|
| `memory-intercept.ts` (production, §3.2.1) | `POST /internal/ingest-memory` | NO |
| `session-start.ts` (§3.4.4) | `GET /internal/regrounding` | NO |
| `compaction.ts` (§3.4.5) | `GET /internal/regrounding` | NO |
| `eval-recorder.ts` (§3.5.1) | `POST /internal/eval-moment` | NO (`/telemetry/eval-moment` exists) |
| `activity-marker.ts` (§3.5.2) | `POST /internal/activity` | NO |
| `continuity-probe.ts` (§3.6.4) | `POST /internal/continuity-probe` | NO |

The build-order tasks (P3-T3, P3-T11, etc.) don't include creating these gateway endpoints. A developer would implement the plugin, test it, and discover the gateway returns 404.

**Fix**: Either (a) add tasks to Phase 2 or Phase 3 for creating these gateway endpoints, or (b) change the plugins to use existing endpoints (e.g., `/telemetry/eval-moment` instead of `/internal/eval-moment`), or (c) document that these endpoints are stubbed (return 200 OK) for Phase 3 local testing and built in Phase 5. Estimated additional effort: 8-12h for the gateway endpoints.

### 3.2 MCP server naming inconsistency — ISSUE FOUND (significant)

| Source | Knowledge MCP name | GTD MCP name |
|---|---|---|
| `mcp-endpoints.json` (gateway plan §1.3) | `ll5-knowledge` | `ll5-gtd` |
| `docker-compose.prod.yml` (actual) | `personal-knowledge` | `gtd` |
| opencode.json (opencode plan §3.7) | `personal-knowledge` | `gtd` |
| proxy routes (opencode plan §2.5.5) | `/personal-knowledge` | `/gtd` |
| security allowlist (security plan §1c) | `pk__get_person` | `gtd__list_events` |

The `mcp-endpoints.json` source-of-truth uses `ll5-` prefixed names (matching the Claude Code convention). The opencode config and proxy use unprefixed names. The security allowlist uses `pk__` (an abbreviation that appears nowhere else).

opencode tool names follow `<server>__<tool>` convention. If the MCP server is named `personal-knowledge` in opencode.json, tools are `personal-knowledge__get_person`, not `pk__get_person`. The external-authority-gate allowlist would fail to match any tool.

**Fix**: Reconcile all naming. Pick one convention per variant:
- Claude Code: `ll5-knowledge`, `ll5-gtd`, etc. (from `mcp-endpoints.json`)
- opencode: `personal-knowledge`, `gtd`, etc. (from `opencode.json`)
- Security allowlist: use the opencode names (`personal-knowledge__get_person`, not `pk__get_person`)

The render script needs to output different server names per format (Claude uses `ll5-*`, opencode uses unprefixed).

### 3.3 `_shared.ts` in plugin array — ISSUE FOUND (minor)

`opencode.json` (§3.7, line 1694) includes `"./.opencode/plugins/_shared.ts"` in the `plugin` array. But `_shared.ts` is a helper module (exports functions like `readState`, `gw`, `readTurnContext`), not a Plugin. opencode would try to call it as a plugin function and fail, or silently ignore it if it doesn't export a default plugin function.

**Fix**: Remove `_shared.ts` from the `plugin` array. It's imported by other plugins via `import { ... } from "./_shared"` — it doesn't need to be loaded as a plugin.

### 3.4 `new_conversation` tool endpoint mismatch — ISSUE FOUND (significant)

`ll5-channel.ts` (§3.2.5, line 957) calls:
```typescript
await gw("/chat/conversations", { platform, remote_jid, text, source })
```

The actual route is `POST /chat/conversations/new` (chat.ts:657) which accepts `{ summary, title }` — completely different body shape. The tool would get a 404 (no route at `/chat/conversations` for POST).

**Fix**: Either (a) add a `POST /chat/conversations` route to the gateway that accepts `{ platform, remote_jid, text }`, or (b) change the tool to call `/chat/conversations/new` with the right body, or (c) use the messaging MCP's `send_whatsapp`/`send_telegram` tools instead (which already handle platform-specific conversation creation).

---

## 4. Testing Feasibility

### 4.1 Testing plan executability — VERIFIED

The testing plan (1417 lines) is executable. Cross-checked:
- `GET /admin/health` endpoint exists (referenced in multiple gateway files)
- `ll5_audit_log`, `ll5_app_log`, `ll5_session_history`, `ll5_reconcile_metrics` ES indices are referenced consistently with `FILE_TREE.md`
- `chat_messages` table exists (migration 002)
- `user_settings` table exists (migration 016)
- `system_alerts` table exists (migration 033)
- `stuck-message-sweep` pass B behavior matches the actual code (lines 139-176 of `stuck-message-sweep.ts`)
- `recordTickOk`/`recordTickError` exist in `scheduler-health.js` (imported in `system-message.ts:5`)

### 4.2 Silent-failure detection checks — VERIFIED

The silent-failure probe script (§6.3) queries the right tables and indices:
- `chat_messages` for agent processing check — correct
- `ll5_audit_log`/`ll5_app_log`/`ll5_session_history` for ES write check — correct
- `ll5_reconcile_metrics` for worker cycling check — correct
- `docker ps | grep -c agent` for duplicate container check — correct
- `warnEsWriteFailure` in gateway logs — this function exists in `@ll5/shared` (`es-auth.ts`, per `FILE_TREE.md:95`)

### 4.3 Phase 2.5 validation checklist — VERIFIED (specific enough)

The 8 validation assumptions (a-h) each have:
- What to check (specific, measurable)
- How to check (concrete commands/actions)
- Success/failure criteria (explicit)
- If-fail action (STOP vs assess)

A developer knows exactly what to do. The probe script (`probe-events.ts`) is real code that would run. The only concern is the `event.subscribe()` return shape (may need `events.stream` — see §2.4).

### 4.4 Test file paths — VERIFIED

- `packages/gateway/src/__tests__/stuck-message-sweep.test.ts` — EXISTS
- `packages/gateway/src/__tests__/system-message.test.ts` — does NOT exist yet (plan correctly marks it as new)
- The plan's claim that "rest unchanged" is verified: consumer tests mock `insertSystemMessage` via `vi.mock`, so the internal `triggerAgent` call is already isolated

---

## 5. Operational Readiness

### 5.1 Docker/CI deployability — ISSUE FOUND (blocking, fixable)

The compose changes are compatible with the existing Coolify setup:
- `traefik.enable=false` prevents auto-exposure — correct
- No published ports — correct
- `depends_on: gateway service_healthy` — correct
- Volume naming follows existing pattern (`xkkcc0g4o48kkcows8488so4_*`)
- Env injection follows existing idempotent pattern (grep -v → mv → append)

But the Dockerfiles have the blocking issues from §1.4 (`--input` flag, opencode.json overwrite, `.ts`/`.js` mismatch). These must be fixed before Phase 4 can produce working images.

### 5.2 Phase 4.5 transition safety — VERIFIED (with inherent risk)

The transition procedure is well-specified:
1. Stop old container → verify stopped
2. Copy volume data (alpine cp -a) → verify file count
3. Remove old container → verify gone
4. Delete Coolify app → **30-minute restart watch** (critical)
5. Deploy compose agent → verify end-to-end

The risk window is real but bounded: between stopping the old agent and the compose agent being ready, the agent is unavailable (estimated 15-30 min). The 30-minute Coolify-restart watch is the right mitigation for the most dangerous silent failure (two agents running).

**Risk assessment**: The rollback path (re-enable old Coolify app) is documented but relies on the old Coolify app being recoverable after deletion. If Coolify doesn't support undelete, the fallback is `docker run` with the old image — which works but requires manual env/volume configuration. The plan should note this.

### 5.3 Rollback procedure — VERIFIED (tested via drill)

The single-var rollback design is sound:
- `OPENCODE_SERVER_URL` is derived from `AGENT_VARIANT` in the deploy script
- Changing `AGENT_VARIANT=opencode` → `AGENT_VARIANT=claude` + deploy = rollback
- The deploy script's idempotent upsert clears `OPENCODE_SERVER_URL` when variant is claude

The rollback drill (testing plan §4.3) is run on a Claude Code day (no-op flip) to measure time-to-rollback. Target: <10 min. This is the right approach — practice before the real cutover.

**Gap**: The drill only exercises the claude→claude path. The real opencode→claude rollback is first tested during the actual cutover. The plan should add a Phase 5 rollback drill (opencode→claude) after the opencode variant is verified working, before Phase 6.

---

## 6. Effort Estimate Sanity Check

### 6.1 Total estimate — REALISTIC (with caveats)

232.5h across 137 tasks for 5-6 weeks. Cross-checked against the code volume:
- Phase 3 (73h, 33 tasks) is the largest — porting 12 plugins + 5 workers + config. At ~2-6h per plugin, this is tight but achievable if the API assumptions hold (Phase 2.5 validates them first).
- Phase 2.5 (26h, 3 days) — reasonable for 8 validation assumptions with probe script
- Phase 1 (18h) — reasonable for file extraction + render script + path audit
- Phase 2 (14h) — reasonable for gateway changes (verified against actual code complexity)

### 6.2 Underestimated tasks

| Task | Estimated | Likely | Reason |
|---|---|---|---|
| P3-T20 (reconcile-loop + 28 security tests) | 6h | 10-12h | 28 TS test cases + worker script + adversarial review |
| P3-T11 (session-start.ts, full re-grounding) | 6h | 8-10h | Calls gateway auth, fetches regrounding, injects via prompt_async — 3 async chains + the `/internal/regrounding` endpoint doesn't exist yet |
| P3-T5 (correlation-id-injector + proxy) | 3h | 6-8h | The Bun→Node rewrite (§1.5) adds 2-3h alone |
| P2-T7 + P2-T8 (test updates) | 3.5h | 5-6h | The test code in the plan is ~200 lines of new test infrastructure |

### 6.3 Most likely to expand ("unknown unknowns")

1. **Correlation-id proxy** — if `Bun.serve` rewrite to Node.js `http` is needed AND SSE streaming pass-through has edge cases (MCP over HTTP uses SSE for server→client), this could expand from 3h to 8-12h.
2. **opencode permission model** — the plan itself flags (§3.7 note) that `AgentConfig.permission` typed shape only enumerates `edit/bash/webfetch/doom_loop/external_directory`, and `"*": "deny"` wildcard support needs Phase 2.5 validation. If the wildcard doesn't work, a `tool.execute.before` plugin fallback is needed (~4h additional).
3. **Missing gateway endpoints** (§3.1) — 6 endpoints need to be built. If scoped to Phase 3, adds 8-12h.
4. **MCP naming reconciliation** (§3.2) — if `mcp-endpoints.json` needs per-format server names, the render script gets more complex (~2h additional).
5. **Persona tuning** (Phase 6.5, 16h) — this is inherently unpredictable. The 14 Hard Rules were tuned over 532 commits for Claude's compliance style. A different model (GPT-5.x, GLM) may need significantly more tuning. Could expand to 24-40h.

### 6.4 Revised estimate

With the fixes and gaps identified: **250-270h** (up from 232.5h). Still within the 5-6 week range if 3 developers are available. With 1-2 developers: 7-9 weeks.

---

## 7. Integration Points

### 7.1 Gateway ↔ opencode plan interface — ISSUE FOUND (blocking)

**MCP config rendering**: The gateway plan's `render-mcp-config.ts` produces:
```json
{ "mcp": { "ll5-knowledge": { "type": "streamable-http", "url": "https://mcp-knowledge.noninoni.click/mcp", "headers": { "Authorization": "Bearer ${MCP_API_KEY}" } } } }
```

The opencode plan's `opencode.json` expects:
```json
{ "mcp": { "personal-knowledge": { "type": "remote", "url": "http://127.0.0.1:4097/personal-knowledge", "enabled": true } } }
```

Three mismatches:
1. **Server names**: `ll5-knowledge` vs `personal-knowledge`
2. **URLs**: direct HTTPS vs proxy localhost
3. **Type**: `streamable-http` vs `remote`

The render script as written produces output that the opencode variant cannot use. The opencode variant needs proxy URLs (for correlation-id injection), not direct HTTPS URLs. The render script would need a third format mode or the opencode variant needs to NOT use the render script for its MCP config.

**Fix**: The opencode variant's `opencode.json` MCP section should be hand-written (pointing at the proxy) and NOT rendered by `render-mcp-config.ts`. The render script is only needed for the Claude Code variant. Remove the render step from `Dockerfile.ll5-run-opencode`.

### 7.2 Session registration ↔ docker-entrypoint — ISSUE FOUND (significant)

The gateway endpoint validates:
```typescript
const validTypes = ['main', 'narrative_loop', 'reconcile_loop']; // underscores
```

The opencode worker scripts send:
```typescript
sessionType: "narrative-loop"   // hyphen — impl-opencode-variant.md §3.6.1 line 1437
sessionType: "reconcile-loop"   // hyphen — impl-opencode-variant.md §3.6.2 line 1497
```

The gateway would reject with 400: `sessionType must be one of: main, narrative_loop, reconcile_loop`.

**Fix**: Change worker scripts to use underscores: `"narrative_loop"`, `"reconcile_loop"`. Or change the gateway validation to accept hyphens and normalize. Underscores in the worker scripts is the simpler fix.

### 7.3 Metadata flow gateway → opencode — ISSUE FOUND (blocking, same as §1.1)

The full metadata flow:
1. Gateway `insertSystemMessage` → `triggerAgent` → HTTP POST with `context: [{ text: "[meta] {...}" }]`
2. opencode receives the prompt — **`context` field is ignored** (not in the API)
3. `turn-context.ts` plugin scans `output.parts` on `chat.message` — **no `[meta]` found**
4. `turn-context.json` not written with external trigger flag
5. `external-authority-gate.ts` reads `turn-context.json` — **fail-closed** (missing/stale context → treats as externally-triggered → denies state-changing tools)

Result: **Every turn would be treated as externally-triggered**, denying all state-changing tools. The agent would be read-only. This is the most critical integration issue.

**Fix** (same as §1.1): Send `[meta]` as the first `parts` element, not as a separate `context` field.

---

## Summary Table

| Criterion | Status | Blocking issues | Significant issues |
|---|---|---|---|
| 1. Code correctness | ISSUE FOUND | 4 (agent-trigger context, Dockerfile --input, opencode.json overwrite, .ts/.js mismatch) + 1 (Bun proxy) | — |
| 2. opencode API accuracy | ISSUE FOUND | — | 2 (security plan turn-context wrong API, chat.message hook unvalidated) |
| 3. Implementation clarity | ISSUE FOUND | — | 3 (missing gateway endpoints, MCP naming, _shared.ts in plugin array) |
| 4. Testing feasibility | VERIFIED | — | — |
| 5. Operational readiness | ISSUE FOUND | (Dockerfile issues from §1 carry over) | 1 (rollback drill gap) |
| 6. Effort estimate sanity | VERIFIED (with caveats) | — | 4-5 tasks likely underestimated |
| 7. Integration points | ISSUE FOUND | 2 (MCP config mismatch, metadata flow broken) | 1 (sessionType hyphen/underscore) |

---

## Recommended Fix Sequence

Before any implementation begins:

1. **Fix `agent-trigger.ts` metadata injection** (§1.1, §7.3) — change `context: [...]` to prepend to `parts`. Update in `impl-gateway-shared.md` §2.1 and `dual-run-variant-plan.md` lines 190-204. **30 min.**

2. **Fix `render-mcp-config.ts` flag** (§1.4A) — change `--input` to `--config` in both Dockerfiles. **5 min.**

3. **Fix opencode.json render overwrite** (§1.4B, §7.1) — remove the render step from `Dockerfile.ll5-run-opencode`; the opencode variant's MCP config is hand-written (proxy URLs). **15 min.**

4. **Fix `.ts`/`.js` mismatch** (§1.4C) — change entrypoint to use `npx tsx` or add a compilation step. **30 min.**

5. **Fix Bun proxy** (§1.5) — rewrite `correlation-id-proxy.ts` using Node.js `http` module instead of `Bun.serve()`. **1-2h.**

6. **Fix security plan's `turn-context.ts`** (§2.1) — update to use `event` hook + `chat.message` direct hook, matching the opencode variant plan's version. **30 min.**

7. **Fix sessionType hyphen/underscore** (§7.2) — change worker scripts to use underscores. **10 min.**

8. **Fix MCP naming** (§3.2) — reconcile server names across mcp-endpoints.json, opencode.json, proxy, security allowlist. **1h.**

9. **Fix `_shared.ts` in plugin array** (§3.3) — remove from `plugin` list. **2 min.**

10. **Fix `new_conversation` endpoint** (§3.4) — align tool call with actual gateway route. **30 min.**

11. **Document missing gateway endpoints** (§3.1) — add tasks or use existing endpoints. **30 min doc fix; 8-12h implementation.**

**Total fix effort: ~4-6h for blocking, ~3-4h for significant.** After fixes, implementation can begin.

---

## What's Done Well

- **Phase 2.5 fail-fast gate** — the single best design decision. 3 days to validate 8 assumptions before 2 weeks of build. Non-negotiable gates (a, c, d) are correctly identified.
- **Single-var rollback** — deriving `OPENCODE_SERVER_URL` from `AGENT_VARIANT` is elegant and eliminates the "forgot to clear the URL" failure mode.
- **Silent failure detection** — the testing plan's 12-item checklist, run after every phase deploy, directly addresses the system's dominant failure class (37h scheduler, 8d ES death).
- **Migration 039** — additive, idempotent, doesn't touch existing data. Safe.
- **Fire-and-forget trigger** — the `void (async () => {...})()` pattern in `system-message.ts` doesn't block the PG insert return path. Correct.
- **opencode variant plan §0** — the API corrections section is honest about what the plan assumed wrong and what the installed types actually show. This is the right approach.
- **Security plan's proxy sidecar analysis** — the 4-option evaluation (headers config, plugin, MCP wrapper, proxy) is thorough and arrives at the correct conclusion (proxy is the only robust option).
- **Build-order dependency graph** — correct identification of hard vs soft dependencies, parallel tracks, critical path.
