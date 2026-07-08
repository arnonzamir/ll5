# Cross-Document Consistency Recheck (Independent Audit #2)

**Date**: 2026-07-08
**Auditor**: Independent verification agent (fresh audit, no knowledge of prior review)
**Documents audited**:
1. `dual-run-variant-plan.md` (master design)
2. `dual-run-build-order.md` (PM task breakdown)
3. `impl-gateway-shared.md` (gateway + shared content)
4. `impl-docker-cicd.md` (Docker + CI/CD)
5. `impl-security.md` (security)
6. `impl-opencode-variant.md` (opencode variant)
7. `impl-testing.md` (testing)

---

## Check 1: MCP server names

**Status: CONSISTENT**

All seven documents use the same server names: `personal-knowledge`, `gtd`, `awareness`, `google`, `messaging`, `health`.

- `dual-run-variant-plan.md:729` — `personal-knowledge, gtd, awareness, google, messaging, health`
- `dual-run-build-order.md:451` — same six names
- `impl-gateway-shared.md:114-149` — mcp-endpoints.json uses these keys; line 64 explicitly documents the rename from old `ll5-knowledge`, `ll5-gtd` names
- `impl-docker-cicd.md:271,640,1163` — same six names
- `impl-security.md:1035-1054` — opencode.json mcp block uses same names
- `impl-opencode-variant.md:505-511,1779-1784` — proxy routes + opencode.json use same names
- `impl-testing.md:115-117` — same six names

**Note**: `impl-security.md:248-254` uses a `pk__` prefix for personal-knowledge tools in the safe-tool allowlist (e.g., `pk__get_person`). This is a tool-name prefix (not a server name), and the document explicitly flags it as needing Phase 2.5 validation (line 244-247: "The actual prefix format must be validated in Phase 2.5 — opencode may use `personal-knowledge__` or `personal_knowledge__` or `pk__`"). This is a known uncertainty, not an inconsistency in server names.

---

## Check 2: sessionType values

**Status: INCONSISTENT**

The gateway implementation uses **hyphenated** sessionType values, but several documents reference **underscored** keys in the JSONB map or acceptance criteria.

| Document | Value format | Location |
|---|---|---|
| `impl-gateway-shared.md:699,742` | Hyphenated: `main`, `narrative-loop`, `reconcile-loop` | Gateway validation array + error message |
| `impl-opencode-variant.md:1502,1561` | Hyphenated: `narrative-loop`, `reconcile-loop` | Worker registration POST bodies |
| `impl-security.md:1151` | Hyphenated: `reconcile-loop` | Worker registration POST body |
| `dual-run-variant-plan.md:260` | Hyphenated (sessionType field) | Worker session mapping description |
| `dual-run-variant-plan.md:261` | **Underscored** (JSONB key names) | `agent_sessions: { main: "uuid", narrative_loop: "uuid", reconcile_loop: "uuid" }` |
| `impl-docker-cicd.md:1311` | **Underscored**: `narrative_loop` + `reconcile_loop` | Acceptance criteria: "Check `agent_sessions` for keys" |
| `impl-testing.md:238,372` | **Underscored**: `narrative_loop` + `reconcile_loop` | Test descriptions: "keys populated" |

**Root cause**: The gateway endpoint (`impl-gateway-shared.md:759-773`) stores the `sessionType` value directly as the JSONB key via `jsonb_build_object($2::text, $3::text)` where `$2` is the hyphenated sessionType. So the actual JSONB keys will be `narrative-loop` and `reconcile-loop` (hyphenated). But `dual-run-variant-plan.md:261`, `impl-docker-cicd.md:1311`, and `impl-testing.md:238,372` all check for underscored keys (`narrative_loop`, `reconcile_loop`).

**Impact**: Acceptance criteria in `impl-docker-cicd.md` and tests in `impl-testing.md` would fail — they'd query `agent_sessions->'narrative_loop'` (underscored) but the key is `narrative-loop` (hyphenated). The master plan's description of the JSON map shape is also wrong.

**Fix**: Standardize on hyphenated keys everywhere (matching the gateway implementation). Update:
- `dual-run-variant-plan.md:261` — change `narrative_loop`/`reconcile_loop` to `narrative-loop`/`reconcile-loop`
- `impl-docker-cicd.md:1311` — change `narrative_loop`/`reconcile_loop` to `narrative-loop`/`reconcile-loop`
- `impl-testing.md:238,372` — change `narrative_loop`/`reconcile_loop` to `narrative-loop`/`reconcile-loop`

---

## Check 3: triggerAgent API format

**Status: INCONSISTENT**

The master plan and security plan use the **wrong** `context` field format. The gateway implementation plan and opencode variant plan correctly use a `parts` entry.

| Document | Format | Correct? |
|---|---|---|
| `dual-run-variant-plan.md:193-204` | Sends `context: [{ type: "text", text: "[meta] ..." }]` as a separate field | **WRONG** |
| `impl-security.md:126-131` | References `context: [{ type: "text", text: "[meta] ..." }]` citing the master plan | **WRONG** |
| `impl-gateway-shared.md:630-654` | Prepends metadata as a `parts` entry: `body.parts = [{ type: 'text', text: '[meta] ...' }, ...]` | **CORRECT** |
| `impl-opencode-variant.md:63` | Confirms `SessionPromptAsyncData.body` has **no `context` field** — only `parts`, `agent`, `noReply`, `system`, `tools`, `model`, `messageID` | **CORRECT** (validates the fix) |

**Impact**: If someone implements from the master plan's pseudocode (line 193-204) instead of the detailed gateway implementation, the opencode API would silently ignore the `context` field — metadata would be lost, and the agent would never see source routing or scheduler event metadata. The `turn-context.ts` plugin parses `[meta]` from `parts`, so if metadata is in `context` instead, the gate's external-trigger detection fails.

**Fix**: Update `dual-run-variant-plan.md:193-204` to match `impl-gateway-shared.md:645-654` (prepend metadata as a `parts` entry, remove `context` field). Update `impl-security.md:126-131` to reference the `parts` format instead of `context`.

---

## Check 4: Endpoint URLs (opencode plugins → gateway)

**Status: INCONSISTENT (one missing endpoint)**

Cross-referenced every `fetch(`${GATEWAY_URL}/...`)` call in `impl-opencode-variant.md` against endpoints documented in `impl-gateway-shared.md`:

| Plugin/Script | Endpoint called | Documented in gateway plan? |
|---|---|---|
| `memory-intercept.ts` (P2.5) | `POST /internal/memory-intercept-log` | Yes (§2.2.1) |
| `memory-intercept.ts` (P3) | `POST /internal/ingest-memory` | Yes (§2.2.1) |
| `ll5-channel.ts` (push_to_user, narrate) | `POST /chat/messages` | Yes (existing) |
| `ll5-channel.ts` (react) | `PATCH /chat/messages/:id` | Yes (existing) |
| `ll5-channel.ts` (new_conversation) | `POST /chat/conversations` | Yes (existing) |
| `session-history.ts` | `POST /sessions` | Yes (existing) |
| `stop-mirror.ts` | `POST /chat/messages` | Yes (existing) |
| `session-start.ts` | `GET /internal/regrounding` | Yes (§2.2.1) |
| `session-start.ts` | `GET /me/onboarding` | Yes (§2.2.1 — fix from `/auth/verify`) |
| `compaction.ts` | `GET /internal/regrounding` | Yes (§2.2.1) |
| `precompact-backup.ts` | `POST /sessions` | Yes (existing) |
| `eval-recorder.ts` | `POST /telemetry/eval-moment` | Yes (§2.2.1 — fix from `/internal/eval-moment`) |
| `activity-marker.ts` | `POST /internal/activity` | Yes (§2.2.1) |
| `narrative-loop.ts` | `POST /internal/agent-session` | Yes (§2.2) |
| `reconcile-loop.ts` | `POST /internal/agent-session` | Yes (§2.2) |
| `continuity-probe.ts` | `POST /internal/continuity-probe` | Yes (§2.2.1) |
| `docker-entrypoint.sh` | `POST /internal/agent-session` | Yes (§2.2) |
| **`memory-recall.ts:1455`** | **`POST /internal/recall-lessons`** | **NO — not documented** |

**Missing endpoint**: `POST /internal/recall-lessons` is called by `memory-recall.ts` (line 1455: `gw("/internal/recall-lessons", { query: text })`) but is NOT in the `impl-gateway-shared.md` §2.2.1 endpoint table. The table lists 8 endpoints; `recall-lessons` is absent.

**Impact**: The memory-recall plugin (P2 plugin, not in P0/P1 set but listed in the full `opencode.json` plugin array at line 1776) would get a 404 from the gateway. Memory recall injection would fail silently.

**Fix**: Add `POST /internal/recall-lessons` to `impl-gateway-shared.md` §2.2.1 endpoint table. It should forward to the awareness MCP's `recall_lessons` tool server-side (same pattern as `/internal/ingest-memory`).

---

## Check 5: Dockerfile flag names

**Status: CONSISTENT**

`render-mcp-config.ts` (in `impl-gateway-shared.md:360-364`) accepts: `--format`, `--output`, `--worker`, `--config`.

Both Dockerfiles in `impl-docker-cicd.md` use `--config` (not `--input`):
- `Dockerfile.ll5-run-claude:80` — `--config /workspace/mcp-endpoints.json`
- `Dockerfile.ll5-run-opencode:179` — `--config /workspace/mcp-endpoints.json`

No `--input` flag appears anywhere in any document.

---

## Check 6: opencode.json output (fragment vs complete)

**Status: CONSISTENT**

Both documents agree the render script outputs a **fragment**, not a complete `opencode.json`:

- `impl-docker-cicd.md:180` — `--output /workspace/opencode-mcp-fragment.json`
- `impl-docker-cicd.md:173-176` — comment: "emits an MCP-only fragment (NOT the full opencode.json — the variant repo's opencode.json has model/agent/plugin config that must NOT be overwritten)"
- `impl-gateway-shared.md:188-190` — "The render script outputs ONLY the `mcp` section — NOT a complete `opencode.json`. The variant repo's `opencode.json` contains model, agent, and plugin config that must NOT be overwritten. The `docker-entrypoint.sh` merges this fragment into the variant repo's `opencode.json` at startup."

---

## Check 7: Proxy runtime (Node.js vs Bun)

**Status: INCONSISTENT**

| Document | Runtime used | Location |
|---|---|---|
| `impl-security.md:1621-1638` | **Node.js** (`createServer` from `node:http`) | Production proxy (§3c) |
| `impl-security.md:1621` comment | "Uses Node's http module (no Bun dependency — runs on plain Node.js)" | |
| `impl-opencode-variant.md:454` | **Bun** (`Bun.serve({...})`) | Minimal proxy (§2.5.5) |
| `impl-opencode-variant.md:418` comment | "Run with: npx tsx scripts/correlation-id-proxy.ts (Node.js, no Bun needed)" | **Contradicts the code** |
| `impl-opencode-variant.md:997` | References "Bun.serve" | Production proxy additions (§3.3) |

**The contradiction in `impl-opencode-variant.md`**: The §2.5.5 section title says "Correlation-id proxy sidecar (minimal, **Bun**)", the comment on line 418 says "Node.js, no Bun needed", but the code on line 454 uses `Bun.serve()` which **requires** the Bun runtime. The Dockerfile (`impl-docker-cicd.md:138-154`) installs `node:20-slim` + `opencode-ai` + `tsx` — **no Bun**.

`impl-security.md` correctly uses Node.js `createServer` and explicitly states no Bun dependency. `impl-opencode-variant.md` uses Bun.serve which would fail at runtime (Bun not installed).

**Impact**: If the §2.5.5 proxy from `impl-opencode-variant.md` is implemented as-is, it crashes on startup — `Bun is not defined`. All MCP tool calls fail (no correlation-ids, no auth headers). This breaks validation (c) — the non-negotiable gate.

**Fix**: Replace `Bun.serve()` in `impl-opencode-variant.md:454-474` and `:997` with the Node.js `createServer` implementation from `impl-security.md:1621-1738`. The security plan's version is the correct one.

---

## Check 8: Worker script execution (tsx vs node)

**Status: CONSISTENT (for workers) — but see NEW issue #2 for proxy**

The entrypoint in `impl-opencode-variant.md:3.10` uses `tsx` for all `.ts` worker scripts:

| Script | Line | Command | Correct? |
|---|---|---|---|
| `register-session.ts` | 2063 | `tsx /workspace/scripts/register-session.ts` | Yes |
| `narrative-loop.ts` | 2076 | `tsx /workspace/scripts/narrative-loop.ts` | Yes |
| `reconcile-loop.ts` | 2077 | `tsx /workspace/scripts/reconcile-loop.ts` | Yes |
| `continuity-probe.ts` | 2078 | `tsx /workspace/scripts/continuity-probe.ts` | Yes |
| `session-backup.ts` | 2084 | `tsx /workspace/scripts/session-backup.ts` | Yes |
| `autoheal.ts` | 2089 | `tsx /workspace/scripts/autoheal.ts` | Yes |

All worker scripts use `tsx` to run `.ts` files. `tsx` is installed globally in the Dockerfile (`impl-docker-cicd.md:154`: `RUN npm install -g tsx`).

---

## Check 9: opencode plugin API (event hook pattern)

**Status: INCONSISTENT**

`impl-opencode-variant.md` §0.2 (line 61) establishes that `session.created`, `session.idle`, `message.updated` are **Event types** dispatched through a single `event` hook — NOT direct hooks. The correct pattern is:
```typescript
event: async ({ event }) => {
  if (event.type === "session.idle") { ... }
}
```

| Document | Plugin | Pattern used | Correct? |
|---|---|---|---|
| `impl-opencode-variant.md` | `session-history.ts:360` | `event` hook + `if (event.type !== "session.idle")` | Yes |
| `impl-opencode-variant.md` | `correlation-id-injector.ts:822` | `event` hook + `if (event.type === "session.created")` | Yes |
| `impl-opencode-variant.md` | `stop-mirror.ts:1096` | `event` hook + `if (event.type !== "session.idle")` | Yes |
| `impl-opencode-variant.md` | `session-start.ts:1162` | `event` hook + `if (event.type !== "session.created")` | Yes |
| `impl-opencode-variant.md` | `eval-recorder.ts:1333` | `event` hook + `if (event.type !== "session.idle")` | Yes |
| `impl-opencode-variant.md` | `file-changed.ts:1416` | `event` hook + `if (event.type !== "file.edited")` | Yes |
| `impl-opencode-variant.md` | `memory-recall.ts:1441` | `event` hook + `if (event.type !== "message.updated")` | Yes |
| `impl-opencode-variant.md` | `turn-context.ts:1284` | `chat.message` (direct hook ✓) + `event` hook for `session.idle` | Yes |
| `impl-security.md` | `external-authority-gate.ts:384` | `"tool.execute.before"` (direct hook — exists per §0.1) | Yes |
| `impl-security.md` | `turn-context.ts:465` | **`"message.updated": async (event) => { ... }`** (direct hook) | **NO** |
| `impl-security.md` | `turn-context.ts:512` | **`"session.idle": async () => { ... }`** (direct hook) | **NO** |
| `impl-security.md` | `session-start.ts` snippet (§3c:1789) | `event` hook + `if (event.type !== "session.created")` | Yes |
| `impl-security.md` | `turn-context.ts` snippet (§3c:1805) | `event` hook + `if (event.type !== "message.updated")` | Yes |

**The inconsistency**: `impl-security.md` §1c `turn-context.ts` (lines 465, 512) uses direct event names (`"message.updated"`, `"session.idle"`) as hook keys. These are NOT in the `Hooks` interface — opencode would silently ignore them. The plugin loads but the handlers never fire.

**However**: `impl-security.md` §3c (lines 1789, 1805) later shows the **corrected** `event` hook pattern for the same plugins. The document is internally inconsistent — §1c is wrong, §3c is right.

**Impact**: If a developer implements `turn-context.ts` from §1c (the detailed full-code version), the external-authority-gate's turn-context detection breaks — `turn-context.json` is never written, the gate fails-closed (denies all state-changing tools on every turn). This is a security-critical silent failure.

**Fix**: Update `impl-security.md` §1c `turn-context.ts` (lines 462-521) to use the `event` hook pattern from §3c (lines 1789-1813). Replace `"message.updated": async (event) => {...}` and `"session.idle": async () => {...}` with a single `event: async ({ event }) => { ... }` handler that switches on `event.type`.

---

## Check 10: Env var names

**Status: INCONSISTENT (LL5_TOKEN missing from compose)**

| Env var | Used in | In compose env? |
|---|---|---|
| `OPENCODE_SERVER_URL` | `impl-gateway-shared.md`, `impl-docker-cicd.md`, `impl-opencode-variant.md`, `impl-testing.md` | Yes (`impl-docker-cicd.md:1088`, `dual-run-variant-plan.md:440`) |
| `OPENCODE_SESSION_ID` | `dual-run-variant-plan.md:30,235` only (as deprecated, replaced by registration endpoint) | N/A (deprecated) |
| `AGENT_VARIANT` | `impl-docker-cicd.md`, `impl-testing.md`, `dual-run-variant-plan.md` | Yes (`impl-docker-cicd.md:982` via image tag, deploy script injects) |
| `GATEWAY_URL` | `impl-opencode-variant.md`, `impl-security.md`, `impl-docker-cicd.md:988` | Yes |
| `MCP_BASE_DOMAIN` | `impl-gateway-shared.md`, `impl-docker-cicd.md:990`, `impl-opencode-variant.md`, `impl-security.md` | Yes |
| **`LL5_TOKEN`** | `impl-opencode-variant.md:205,280,355,594,669,711,906,1144,1175,1499,1558,1696` + `impl-security.md:1147` | **NO** |

**Missing env var**: `LL5_TOKEN` is used by every opencode plugin and worker script for gateway authentication (`Authorization: Bearer ${LL5_TOKEN}`), but it is NOT in the compose environment block in either `impl-docker-cicd.md:984-998` or `dual-run-variant-plan.md:389-399`. The compose env block includes `API_KEY`, `USER_ID`, `GATEWAY_URL`, `MCP_BASE_DOMAIN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENCODE_ZEN_API_KEY` — but not `LL5_TOKEN`.

**Impact**: All opencode plugin HTTP calls to the gateway would send `Authorization: Bearer ` (empty token) → 401 → every gateway interaction fails silently (plugins catch errors and continue). Session registration, memory intercept, session history, stop-mirror, eval-recorder, activity-marker, regrounding — all fail. The agent runs but can't interact with the gateway.

**Fix**: Add `LL5_TOKEN: ${LL5_TOKEN:-}` to the compose env block in `impl-docker-cicd.md:984-998` and `dual-run-variant-plan.md:389-399`. Add `LL5_TOKEN` to the deploy script's idempotent `.env` injection. If `LL5_TOKEN` is the same as `API_KEY`, map it: `LL5_TOKEN: ${API_KEY}` (but verify they're the same token — `API_KEY` may be the MCP auth token while `LL5_TOKEN` is the gateway chat-auth token).

---

## NEW Issues Found (not in the original 10 checks)

### NEW #1: personal-knowledge proxy subdomain mismatch

**Status: INCONSISTENT**

The correlation-id proxy routes for `personal-knowledge` use different subdomains:

| Document | Subdomain used | Correct? |
|---|---|---|
| `impl-opencode-variant.md:428` | `mcp-personal-knowledge` | **WRONG** |
| `impl-security.md:1633` | `mcp-knowledge` | **CORRECT** |
| `impl-gateway-shared.md:115` | `mcp-knowledge` (in mcp-endpoints.json `subdomain` field) | **CORRECT** |
| `impl-gateway-shared.md:213` | Explicitly notes: "For `personal-knowledge`, the Traefik rule is `Host(\`mcp-knowledge.noninoni.click\`)` (not `mcp-personal-knowledge`)" | **CORRECT** |

`impl-opencode-variant.md` §2.5.5 proxy uses `https://mcp-personal-knowledge.${MCP_BASE_DOMAIN}/mcp` which would 404 — the Traefik routing rule is `mcp-knowledge.noninoni.click`, not `mcp-personal-knowledge.noninoni.click`.

**Impact**: The personal-knowledge MCP is unreachable from the opencode variant's §2.5.5 proxy. All `pk__*` / `personal-knowledge__*` tool calls fail. This affects Phase 2.5 validation (h) `/daily` skill (which may call personal-knowledge tools) and Phase 3 production.

**Fix**: Change `impl-opencode-variant.md:428` from `mcp-personal-knowledge` to `mcp-knowledge` to match the Traefik rule and mcp-endpoints.json.

### NEW #2: Correlation-id proxy file extension mismatch (.ts vs .js)

**Status: INCONSISTENT**

The entrypoints in both documents call `node /workspace/scripts/correlation-id-proxy.js` but the source file is `correlation-id-proxy.ts`:

| Document | Entrypoint command | Source file | Issue |
|---|---|---|---|
| `impl-opencode-variant.md:2027` | `node /workspace/scripts/correlation-id-proxy.j &` | `scripts/correlation-id-proxy.ts` (line 566) | `.js` file doesn't exist — no compile step in Dockerfile |
| `impl-security.md:1835` | `node /workspace/scripts/correlation-id-proxy.j &` | `scripts/correlation-id-proxy.ts` (line 1616) | Same |

The Dockerfile (`impl-docker-cicd.md:165-169`) COPYs `variant-content/scripts/` to `/workspace/scripts/` — the `.ts` files land there. There is no `tsc` or `tsx` compile step for the proxy. `node` cannot execute `.ts` files.

**Impact**: The correlation-id proxy fails to start — `node` can't find `correlation-id-proxy.js` (file doesn't exist) or can't parse `.ts` syntax. All MCP tool calls fail (no auth, no correlation-ids). This is a startup blocker.

**Fix**: Change the entrypoint to `tsx /workspace/scripts/correlation-id-proxy.ts &` (matching the pattern used for all other worker scripts). `tsx` is already installed globally in the Dockerfile.

### NEW #3: impl-testing.md expects old `context` format in triggerAgent test

**Status: INCONSISTENT**

`impl-testing.md:149` describes the expected triggerAgent POST body as:
> POST received with `parts[0].text` + `context[0].text` containing `[meta] {...}`

But the actual implementation (`impl-gateway-shared.md:645-654`) puts metadata as a `parts` entry, NOT a `context` field. The test description expects `context[0].text` which would be undefined — the metadata is in `parts[0].text` (prepended before the content).

**Impact**: The Phase 2 test would check for `context[0].text` (undefined) and incorrectly report that metadata isn't reaching the agent, even when it is (in `parts[0].text`).

**Fix**: Update `impl-testing.md:149` to: `POST received with parts[0].text containing [meta] {...} (metadata) and parts[1].text containing the content`.

### NEW #4: Master plan sessionType JSONB key description doesn't match implementation

This is the same root issue as Check 2 but specifically in the master plan's architecture description.

`dual-run-variant-plan.md:261`:
> `user_settings` stores a JSON map: `agent_sessions: { main: "uuid", narrative_loop: "uuid", reconcile_loop: "uuid" }`

But the gateway implementation (`impl-gateway-shared.md:759-773`) stores the `sessionType` value (hyphenated) directly as the JSONB key. The actual stored shape is:
```json
{ "main": "uuid", "narrative-loop": "uuid", "reconcile-loop": "uuid" }
```

The master plan's underscored description is wrong. (Already listed under Check 2 but called out here as a separate master-plan text fix.)

### NEW #5: impl-opencode-variant.md §3.3 references Bun.serve in production additions

`impl-opencode-variant.md:997` says:
> Add at the end, after Bun.serve:

This assumes the production proxy also uses `Bun.serve`, but the production proxy is in `impl-security.md` which correctly uses Node.js `createServer`. The §3.3 additions (signal handlers, logging) reference `server.stop()` which is a Bun.serve API — Node's `http.Server` uses `server.close()` instead.

**Fix**: Update `impl-opencode-variant.md:997-999` to reference `server.close()` (Node.js API) instead of `server.stop()` (Bun API), and remove the "after Bun.serve" reference.

---

## Summary Table

| # | Check | Status | Documents in conflict |
|---|---|---|---|
| 1 | MCP server names | CONSISTENT | — |
| 2 | sessionType values | **INCONSISTENT** | `dual-run-variant-plan.md`, `impl-docker-cicd.md`, `impl-testing.md` (underscored keys vs hyphenated gateway impl) |
| 3 | triggerAgent API | **INCONSISTENT** | `dual-run-variant-plan.md`, `impl-security.md` (use `context` field; should be `parts` entry) |
| 4 | Endpoint URLs | **INCONSISTENT** | `impl-opencode-variant.md` calls `/internal/recall-lessons` — not documented in `impl-gateway-shared.md` |
| 5 | Dockerfile flag names | CONSISTENT | — |
| 6 | opencode.json output (fragment) | CONSISTENT | — |
| 7 | Proxy runtime (Node vs Bun) | **INCONSISTENT** | `impl-opencode-variant.md` uses `Bun.serve()` (Bun not installed); `impl-security.md` correctly uses `createServer` |
| 8 | Worker script execution (tsx) | CONSISTENT | — (but see NEW #2 for proxy) |
| 9 | opencode plugin API (event hook) | **INCONSISTENT** | `impl-security.md` §1c `turn-context.ts` uses direct event names (wrong); §3c is correct |
| 10 | Env var names | **INCONSISTENT** | `LL5_TOKEN` used by plugins but missing from compose env in `impl-docker-cicd.md` + `dual-run-variant-plan.md` |

### NEW issues

| # | Issue | Severity |
|---|---|---|
| N1 | `personal-knowledge` proxy subdomain: `mcp-personal-knowledge` (wrong) vs `mcp-knowledge` (correct) in `impl-opencode-variant.md:428` | High — MCP unreachable |
| N2 | Proxy file extension: entrypoint runs `node ... .js` but source is `.ts`, no compile step | Critical — proxy won't start |
| N3 | `impl-testing.md:149` expects `context[0].text` (old format) in triggerAgent test | Medium — false test failure |
| N4 | Master plan JSONB key description uses underscores; gateway impl uses hyphens | Low — documentation only (same root as Check 2) |
| N5 | `impl-opencode-variant.md:997` references `Bun.serve` + `server.stop()` in production proxy additions | Medium — API mismatch with Node.js `createServer` |

---

## Recommended Fix Priority

1. **Critical (blocks startup)**: N2 — proxy `.ts`/`.js` mismatch → change entrypoint to `tsx`
2. **Critical (blocks startup)**: Check 7 — `Bun.serve` in `impl-opencode-variant.md` → replace with `createServer`
3. **Critical (blocks all gateway interaction)**: Check 10 — `LL5_TOKEN` missing from compose env
4. **High (breaks MCP)**: N1 — `mcp-personal-knowledge` subdomain → change to `mcp-knowledge`
5. **High (security-critical silent failure)**: Check 9 — `turn-context.ts` direct event names → use `event` hook
6. **High (metadata loss)**: Check 3 — `context` field in triggerAgent → use `parts` entry
7. **High (worker session registration rejected)**: Check 2 — underscored JSONB keys → use hyphenated
8. **Medium (missing endpoint)**: Check 4 — add `/internal/recall-lessons` to gateway plan
9. **Medium (test false failure)**: N3 — update test to expect `parts[0].text` not `context[0].text`
10. **Low (doc consistency)**: N4, N5 — fix references in master plan + opencode variant
