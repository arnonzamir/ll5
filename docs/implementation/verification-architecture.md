# Architecture Verification Report — Dual Run-Variant Migration

**Date**: 2026-07-08
**Verifier**: Senior Systems Architect (final verification pass)
**Documents reviewed**:
1. `dual-run-variant-plan.md` (master plan v2)
2. `dual-run-build-order.md` (PM build order, 137 tasks)
3. `impl-gateway-shared.md` (Backend Architect, Phases 1+2)
4. `impl-docker-cicd.md` (DevOps, Phases 4+4.5+5)
5. `impl-security.md` (Security Engineer, security-critical)
6. `impl-opencode-variant.md` (Senior Developer, Phases 2.5+3)
7. `impl-testing.md` (Reality Checker, testing plans)

---

## Overall Verdict: NOT READY — requires one revision pass

The plans are architecturally sound in their high-level design (shared/variant split, fail-fast gate, single-var rollback, per-responsibility bridge mapping). The Senior Developer's API corrections are a major contribution that grounds the opencode plan in reality. However, **8 blocking inconsistencies** and **6 significant gaps** remain. These would cause build failures, runtime 404s, or silent metadata loss during implementation. A focused revision pass (estimated 4-6 hours of doc work, no code) is needed before any implementation begins.

---

## 1. Cross-Document Consistency

### 1.1 Consistency of file paths, env vars, config formats

**Verdict: FAIL — 4 blocking inconsistencies**

#### Inconsistency 1: `render-mcp-config.ts` CLI flag mismatch (BLOCKING)

- **Gateway plan** (`impl-gateway-shared.md:356`): the script implementation parses `--config` flag:
  ```typescript
  const v = getVal('--format') ?? getVal('--output') ?? getVal('--worker') ?? getVal('--config');
  ```
- **Docker plan** (`impl-docker-cicd.md:79-82`): the Dockerfile calls the script with `--input`:
  ```dockerfile
  RUN npx tsx /workspace/scripts/render-mcp-config.ts \
        --format claude \
        --input /workspace/mcp-endpoints.json \
        --output /workspace/.claude/settings.json
  ```
- The script has no `--input` flag. The Docker build would silently use the default config path (`packages/ll5-run-shared/mcp-endpoints.json`), which doesn't exist at `/workspace/` during build. **The render step would fail or produce empty output.**
- **Fix**: Change all Dockerfile invocations from `--input` to `--config`, OR add `--input` as an alias in the script's arg parser.

#### Inconsistency 2: `opencode.json` overwrite by render script (BLOCKING)

- **Docker plan** (`impl-docker-cicd.md:175-178`): renders MCP config directly to `/workspace/opencode.json`:
  ```dockerfile
  RUN npx tsx /workspace/scripts/render-mcp-config.ts \
        --format opencode \
        --input /workspace/mcp-endpoints.json \
        --output /workspace/opencode.json
  ```
- **opencode plan** (`impl-opencode-variant.md:1685-1761`): the variant repo's `opencode.json` is a COMPLETE config with `$schema`, `model`, `small_model`, `permission`, `instructions`, `plugin` array (17 entries), `mcp` section, and `agent` definitions. The Dockerfile copies this from `variant-content/.opencode/` before the render step.
- The render script's `renderOpencode()` returns `{ mcp: { ... } }` — just the MCP section. Writing this to `/workspace/opencode.json` **overwrites the complete config** (model, permissions, plugins, agents all destroyed).
- The gateway plan (`impl-gateway-shared.md:236-238`) mentions a `--section mcp` flag for merging, but this flag is **not implemented** in the script code and **not used** in the Dockerfile.
- **Fix**: Either (a) render to a separate file (e.g. `/workspace/mcp-rendered.json`) and merge at runtime, (b) implement the `--section mcp` merge logic in the script, or (c) don't use render-mcp-config.ts for opencode at all — the variant repo's `opencode.json` is hand-maintained with proxy URLs that the script doesn't know about.

#### Inconsistency 3: MCP server naming convention (BLOCKING)

Three different naming conventions across three plans:

| Plan | MCP key names | Example tool prefix |
|---|---|---|
| Gateway plan (`mcp-endpoints.json`) | `ll5-knowledge`, `ll5-gtd`, `ll5-awareness`, `ll5-calendar`, `ll5-health`, `ll5-messaging` | `ll5-knowledge__search_knowledge` |
| opencode plan (`opencode.json`) | `personal-knowledge`, `gtd`, `awareness`, `google`, `messaging`, `health` | `gtd__list_events` |
| Security plan (allowlist) | (assumes) `pk`, `gtd`, `awareness`, `google`, `messaging`, `health` | `pk__get_person` |

- The opencode plugin tool naming convention is `<server_key>__<tool_name>`. If the MCP server is named `personal-knowledge` in `opencode.json`, tools are `personal-knowledge__get_person`, NOT `pk__get_person` as the security plan's allowlist assumes.
- The security plan's `SAFE_TOOL_PATTERNS` array (`impl-security.md:215-268`) uses `pk__get_person`, `pk__list_facts`, etc. These would **never match** if the server is named `personal-knowledge`.
- Similarly, `ll5-knowledge__search_knowledge` (from the gateway plan's naming) would never match `awareness__search_knowledge` (from the security plan).
- **Impact**: The external-authority-gate's allowlist would deny ALL tools on externally-triggered turns (fail-closed by default for unrecognized tools), OR allow all tools if the naming mismatch means the allowlist is effectively empty. Either way, the security boundary is broken.
- **Fix**: Align on ONE naming convention. Recommendation: use the non-prefixed names (`gtd`, `awareness`, `personal-knowledge`, `google`, `messaging`, `health`) everywhere — in `mcp-endpoints.json`, `opencode.json`, the security plan's allowlist, and the render script output. Update the security plan's `pk__` references to `personal-knowledge__`.

#### Inconsistency 4: Migration filename (MINOR)

- **Build-order** (`dual-run-build-order.md:255`): `packages/gateway/src/migrations/039_agent_session.sql`
- **Gateway plan** (`impl-gateway-shared.md:791`): `packages/gateway/src/migrations/039_agent_session_id.sql`
- **Fix**: Pick one filename. The gateway plan's version (`039_agent_session_id.sql`) is more descriptive.

---

### 1.2 `agent-trigger.ts` interface consistency

**Verdict: FAIL — 1 blocking inconsistency**

#### Inconsistency 5: `context` field in prompt_async body (BLOCKING)

- **Master plan** (`dual-run-variant-plan.md:198-203`) and **gateway plan** (`impl-gateway-shared.md:643-649`): `triggerAgent` sends metadata via a `context` field in the request body:
  ```typescript
  body.context = [{
    type: 'text',
    text: `[meta] ${JSON.stringify(payload.metadata)}`,
  }];
  ```
- **opencode plan** (`impl-opencode-variant.md:63`, §0.2): the Senior Developer's API research found that `SessionPromptAsyncData.body` has **no `context` field**. The type surface only accepts: `parts`, `agent`, `noReply`, `system`, `tools`, `model`, `messageID`.
- The opencode plan says metadata should be injected as a `TextPartInput` prepended to `parts`:
  ```
  {type:"text", text:"[meta] {...}"}  ← prepended to parts array
  ```
- **Impact**: The `context` field would be silently dropped by opencode (or cause a 400 error). The agent would never see source routing metadata. The `turn-context.ts` plugin scans `parts` (via `chat.message` hook's `output.parts`), not `context` — so it would never detect external triggers. **The external-authority-gate would fail-closed on every turn** (missing turn-context → fail-closed → deny all state-changing tools), or fail-open if the gate doesn't fire at all.
- **Fix**: Update `triggerAgent` in both the master plan and gateway plan to prepend metadata as a `parts` entry:
  ```typescript
  const parts = [];
  if (payload.metadata) {
    parts.push({ type: 'text', text: `[meta] ${JSON.stringify(payload.metadata)}` });
  }
  parts.push({ type: 'text', text: payload.content });
  body.parts = parts;
  ```
- The opencode plan's `turn-context.ts` (`impl-opencode-variant.md:1278-1304`) already scans `output.parts` for `[meta]` — so this fix would make the end-to-end flow work.

---

### 1.3 Session registration mechanism consistency

**Verdict: FAIL — 1 blocking inconsistency**

#### Inconsistency 6: sessionType naming (BLOCKING)

- **Gateway plan** (`impl-gateway-shared.md:737`): valid session types are `['main', 'narrative_loop', 'reconcile_loop']` (underscored)
- **Master plan** (`dual-run-variant-plan.md:260`): `sessionType` field values `main`, `narrative-loop`, `reconcile-loop` (hyphenated)
- **opencode plan** (`impl-opencode-variant.md:1437`): workers register with `sessionType: "narrative-loop"` (hyphenated)
- **opencode plan** (`impl-opencode-variant.md:1496`): `sessionType: "reconcile-loop"` (hyphenated)
- The gateway endpoint validates sessionType against the underscored list and returns **400 Bad Request** for invalid types.
- **Impact**: All worker session registrations (narrative-loop, reconcile-loop) would be rejected. The gateway would have no worker session IDs in `user_settings.agent_sessions`. Schedulers targeting workers would find null sessions → no trigger → workers never run.
- **Fix**: Standardize on ONE convention. The gateway plan's underscored convention (`narrative_loop`, `reconcile_loop`) is more consistent with JSON/JS naming. Update the master plan and opencode plan to use underscores. Alternatively, make the gateway endpoint accept both.

---

### 1.4 MCP config rendering consistency

**Verdict: FAIL — covered by Inconsistency 2 and 3 above**

The gateway plan's render script produces opencode MCP config with:
- Direct remote URLs (`https://mcp-knowledge.noninoni.click/mcp`)
- `type: "streamable-http"`
- Static `Authorization` header
- Server keys: `ll5-knowledge`, `ll5-gtd`, etc.

The opencode plan's actual `opencode.json` uses:
- Local proxy URLs (`http://127.0.0.1:4097/personal-knowledge`)
- `type: "remote"`
- No headers (proxy handles auth)
- Server keys: `personal-knowledge`, `gtd`, etc.

These are fundamentally incompatible architectures. The render script assumes direct-to-remote with static headers. The opencode plan uses a proxy sidecar for dynamic correlation-id injection. The Dockerfile's render step would produce a config that doesn't match the proxy architecture.

---

### 1.5 Dockerfile paths and compose service names

**Verdict: PASS**

All plans agree on:
- `docker/Dockerfile.ll5-run-claude`
- `docker/Dockerfile.ll5-run-opencode`
- Compose service name: `agent`
- Container name: `agent-xkkcc0g4o48kkcows8488so4`
- Image names: `ghcr.io/arnonzamir/ll5-run-claude:latest`, `ghcr.io/arnonzamir/ll5-run-opencode:latest`
- Coolify UUIDs: `xkkcc0g4o48kkcows8488so4` (main), `js8owk0g0cgog800ckc8ww0s` (old standalone)

---

## 2. Completeness

### 2.1 Every build-order task has implementation detail?

**Verdict: PASS WITH MINOR GAPS**

All 137 tasks in the build-order have corresponding implementation detail in at least one impl plan, with two minor exceptions:

| Task | Gap | Impact |
|---|---|---|
| P1-T10 | "Update ll5-run-claude-code CI to copy shared content" — no impl plan details the variant repo's own CI changes for Phase 1 | Low — the change is trivial (add a COPY step to the variant repo's Dockerfile/CI) |
| P3-T30 | "Add CI workflow `trigger-ll5-rebuild.yml`" — referenced but no YAML provided | Low — the pattern is described in text; the YAML is straightforward |

### 2.2 Implementation details not in build-order

**Verdict: FAIL — 6 undocumented gateway endpoints + 3 missing components**

The opencode plan's plugins call gateway endpoints that are NOT in the gateway plan or build-order:

| Endpoint | Called by | Phase | In gateway plan? | In build-order? |
|---|---|---|---|---|
| `POST /internal/ingest-memory` | `memory-intercept.ts` (§3.2.1) | 3 | NO | NO |
| `GET /internal/regrounding` | `session-start.ts` (§3.4.4), `compaction.ts` (§3.4.5) | 3 | NO | NO |
| `POST /internal/eval-moment` | `eval-recorder.ts` (§3.5.1) | 3 | NO | NO |
| `POST /internal/activity` | `activity-marker.ts` (§3.5.2) | 3 | NO | NO |
| `POST /internal/continuity-probe` | `continuity-probe.ts` (§3.6.4) | 3 | NO | NO |
| `POST /internal/memory-intercept-log` | `memory-intercept.ts` (§2.5.2) | 2.5 | NO | NO |

**Impact**: These endpoints don't exist in the gateway. Every plugin that calls them will get 404 errors. The plugins catch errors silently (`catch { /* fire-and-forget */ }`), so the failures would be **silent** — the agent appears to work but memory interception, session history, eval recording, activity tracking, and re-grounding all silently fail.

Additionally, these components are in the opencode plan but not in the build-order:

| Component | opencode plan reference | Build-order task? |
|---|---|---|
| Correlation-id proxy sidecar (`scripts/correlation-id-proxy.ts`) | §3.3, ~80 lines | P3-T5 covers the plugin, NOT the proxy |
| `_shared.ts` plugin helpers | §3.1, ~70 lines | Implicit in P3-T2 |
| `register-session.ts` helper | §3.10 | Not tasked |

**Fix**: Add these to the gateway plan (Phase 2 or a new Phase 2.1) and the build-order. The gateway endpoints are additive (new routes, no changes to existing code) and can be built in parallel with Phase 2. Estimated additional effort: ~8-12h.

### 2.3 Testing coverage per phase

**Verdict: PASS**

Every phase (0, 1, 2, 2.5, 3, 4, 4.5, 5, 6, 7) has dedicated testing coverage in `impl-testing.md`:
- Per-phase loud/silent/regression/rollback test tables (§1.1–§1.10)
- Phase 2.5 detailed validation protocols (§2.1–§2.9)
- Phase 6 behavioral parity framework (§3)
- Phase 7 24-hour monitoring plan (§4)
- Reusable silent-failure checklist (§5)
- Test automation map (§6)

---

## 3. Dependency Integrity

### 3.1 PM's dependency graph matches actual dependencies?

**Verdict: PASS WITH HIDDEN DEPENDENCIES**

The explicit dependency graph is correct:
```
0 → 1 → 4
2 → 2.5 → 3 → 4 → 4.5 → 5 → 6 → 7
```

No circular dependencies. The parallel-track structure (Track A: 0→1, Track B: 2→2.5→3) is sound.

### 3.2 Hidden dependencies the PM missed

**3 hidden dependencies:**

| Hidden dependency | Impact | Fix |
|---|---|---|
| **Gateway endpoints for opencode plugins** — 6 new endpoints needed before Phase 3 plugins can function | Phase 3 plugins will 404 silently | Add a Phase 2.1 (or extend Phase 2) task set for these endpoints |
| **Bun runtime in opencode container** — the proxy sidecar uses `Bun.serve()`, but the Dockerfile (`impl-docker-cicd.md:144-151`) only installs `node:20-slim` + `opencode-ai` + `tsx`. No Bun. | Proxy won't start; all MCP tool calls fail (no correlation-ids, no auth) | Add `npm install -g bun` to the Dockerfile, OR rewrite the proxy using Node's `http` module / Hono / Express |
| **TypeScript compilation for worker scripts** — the entrypoint (`impl-opencode-variant.md:2008-2010`) calls `node /workspace/scripts/narrative-loop.js` (`.js` extension), but the scripts are `.ts` files. No compile step in the Dockerfile. | Workers crash immediately — `node` can't execute `.ts` files | Either (a) add a `tsc` or `tsx` compile step to the Dockerfile, (b) change the entrypoint to use `npx tsx /workspace/scripts/narrative-loop.ts`, or (c) pre-compile in the variant repo CI |

### 3.3 Circular dependencies

**Verdict: PASS — none found**

---

## 4. Security Coverage

### 4.1 External-authority-gate plugin match

**Verdict: PASS WITH NAMING CAVEAT**

The security plan's `external-authority-gate.ts` (`impl-security.md:172-401`) and the opencode plan's version (`impl-opencode-variant.md:736-802`) are logically consistent:
- Same hook: `tool.execute.before`
- Same safe-tool allowlist (copied verbatim)
- Same always-denied hard floor
- Same fail-closed behavior on missing/stale turn-context
- Same deny mechanism (throw)

**Caveat**: The always-denied set uses `ll5channel__push_to_user` etc., but the opencode plan's `ll5-channel.ts` defines tools as `push_to_user` (without prefix). Custom plugin tools may not get the `ll5channel__` prefix. However, the gate's default-deny logic (anything not in the allowlist is denied) means `push_to_user` would still be denied on externally-triggered turns — just not via the explicit always-denied set. Functionally safe, but the intent documentation is wrong.

### 4.2 Reconcile worker design match

**Verdict: FAIL — two different permission mechanisms**

- **Security plan** (`impl-security.md:918-1079`): uses `"permission": { "*": "deny", ...4 allows..., "task": {"*": "deny"} }` — wildcard deny + specific allows
- **opencode plan** (`impl-opencode-variant.md:1741-1758`): uses `"tools": { ...boolean map... }` + `"permission": { "edit": "deny", "bash": "deny", "webfetch": "deny" }` — boolean tool map + limited permission block

These are two different mechanisms. The opencode plan's §0.2 correction (`impl-opencode-variant.md:65`) found that `AgentConfig.permission` only has typed fields for `edit/bash/webfetch/doom_loop/external_directory` — the `"*": "deny"` wildcard is NOT in the typed shape (though the docs claim it works via pattern matching). The opencode plan hedges: "Must validate in Phase 2.5."

**Impact**: If `"*": "deny"` doesn't work at runtime (only documented, not typed), the security plan's approach fails silently — the reconcile worker would have ALL tools available. The opencode plan's `tools` boolean map is the typed fallback, but it's a **denylist of falses** (tools not listed default to `true`/enabled), not an allowlist. Unlisted MCP tools would be available.

**Fix**: The opencode plan's §3.7 note (`impl-opencode-variant.md:1772-1774`) already specifies the fallback: add a `reconcile-gate.ts` plugin using `tool.execute.before` that checks `input.sessionID` against the reconcile-worker session and denies non-allowlisted tools mechanically. This plugin-level enforcement is the safest approach and should be the PRIMARY mechanism, with config-level permissions as defense-in-depth. Both plans should agree on this.

### 4.3 Correlation-id approach match

**Verdict: PASS**

Both the security plan (`impl-security.md:1595-1606`) and the opencode plan (`impl-opencode-variant.md:404-473`, `982-1000`) agree on the proxy sidecar approach (Option D):
- Local HTTP proxy on port 4097
- Reads `~/.ll5/token`, `~/.ll5/agent-session-id`, `~/.ll5/agent-trace-id` per-request
- Injects `Authorization`, `X-LL5-Session-Id`, `X-LL5-Trace-Id` headers
- Forwards to real remote MCP URLs
- Handles SSE streaming pass-through

The security plan's fallback (`impl-security.md:1842-1893`) is consistent with the opencode plan's fallback (`impl-opencode-variant.md:1002-1006`): use `{file:path}` substitution for session-id only, accept NULL trace-id, restart opencode on token refresh.

**Caveat**: The proxy uses `Bun.serve()` but the Dockerfile doesn't install Bun (see hidden dependency §3.2). The entrypoint calls `node /workspace/scripts/correlation-id-proxy.js` but the script uses Bun-specific APIs. This is a runtime blocker, not a design inconsistency.

### 4.4 All 16 hooks accounted for

**Verdict: FAIL — hook #6 (memory-recall) has no implementation**

| # | Hook | opencode plugin | Build-order task | Status |
|---|---|---|---|---|
| 1 | cron-block | `cron-block.ts` | P3-T8 | ✓ |
| 2 | repo-write-block | `repo-write-block.ts` | P3-T9 | ✓ |
| 3 | memory-intercept | `memory-intercept.ts` | P3-T3 | ✓ |
| 4 | external-authority-gate | `external-authority-gate.ts` | P3-T4 | ✓ |
| 5 | stop-mirror | `stop-mirror.ts` | P3-T10 | ✓ |
| **6** | **memory-recall** | **NOT IMPLEMENTED** | **NO TASK** | **✗ GAP** |
| 7 | session-start | `session-start.ts` | P3-T11 | ✓ |
| 8 | session-save | `session-history.ts` | P3-T6 | ✓ |
| 9 | eval-record | `eval-recorder.ts` | P3-T15 | ✓ |
| 10 | activity-marker | `activity-marker.ts` | P3-T16 | ✓ |
| 11 | narration-watchdog | `narration-watchdog.ts` | P3-T17 | ✓ |
| 12 | cli-input-mirror | Dropped (justified) | — | ✓ |
| 13 | check-token | Merged into session-start.ts | P3-T11 | ✓ |
| 14 | precompact-backup | `precompact-backup.ts` | P3-T13 | ✓ |
| 15 | file-changed | `file-changed.ts` | P3-T18 | ✓ |
| 16 | get-mcp-auth | correlation-id-injector + proxy | P3-T5 | ✓ |

**Hook #6 (memory-recall)**: The master plan (`dual-run-variant-plan.md:150`) says: "SDK injection: chat bridge calls recall_lessons, prepends as noReply context." This fires on `UserPromptSubmit` (before each prompt). No opencode plugin implements this. The `session-start.ts` plugin does re-grounding at session creation, but NOT per-prompt recall.

The opencode plan has `experimental.chat.system.transform` and `experimental.chat.messages.transform` hooks available (`impl-opencode-variant.md:48-49`) which could inject recall context before each prompt. But no plugin uses them for this purpose.

**Impact**: The opencode agent would reason without per-prompt memory recall. It would still get re-grounding at session start, but within a long session, it wouldn't recall new lessons learned mid-session. This is a P1 behavioral parity gap.

**Fix**: Add a `memory-recall.ts` plugin (P1) that uses `experimental.chat.messages.transform` or `chat.message` hook to call `recall_lessons` via the proxy and prepend the result as context. Add a build-order task (P3-T14.5 or similar).

---

## 5. Critical Gaps

### 5.1 Blocking gaps

| # | Gap | Severity | Blocks which phase? |
|---|---|---|---|
| 1 | `triggerAgent` sends `context` field that opencode API doesn't accept | **Critical** | Phase 2.5, 5 — metadata silently dropped |
| 2 | 6 undocumented gateway endpoints needed by opencode plugins | **Critical** | Phase 3, 5 — plugins 404 silently |
| 3 | `render-mcp-config.ts` `--input` flag doesn't exist (script uses `--config`) | **High** | Phase 4 — Docker build fails or produces empty config |
| 4 | Render script overwrites complete `opencode.json` with just the MCP section | **High** | Phase 4 — opencode container won't start (no model, no plugins, no agents) |
| 5 | MCP server naming inconsistency (`ll5-knowledge` vs `personal-knowledge` vs `pk__`) | **High** | Phase 3, 5 — security gate allowlist broken |
| 6 | sessionType naming mismatch (`narrative-loop` vs `narrative_loop`) | **High** | Phase 5 — worker session registration rejected (400) |
| 7 | Bun runtime missing from opencode Dockerfile | **High** | Phase 5 — proxy sidecar won't start |
| 8 | TypeScript compilation missing for worker scripts | **High** | Phase 5 — workers crash on startup |

### 5.2 TODO/TBD items that are actually blocking

| Item | Location | Blocking? | Assessment |
|---|---|---|---|
| "opencode equivalent TBD in Phase 2.5" (cron-block) | master plan:145 | No | Resolved in opencode plan §3.4.1 |
| "validate in Phase 2.5" (autoheal) | master plan:134 | No | Conditional on P2.5(e); fallback specified |
| `"*": "deny"` wildcard must be validated | opencode plan:1768 | No for Phase 2.5; **Yes for Phase 3** | If unvalidated, reconcile worker security is uncertain. Fallback: plugin-level deny. Must be resolved before P3-T20. |
| `{file:path}` lazy vs eager | security plan:1531 | No | Phase 2.5 validation (c) covers this |

### 5.3 Senior Developer's API findings — impact on other plans

The opencode plan §0 makes three critical corrections from the installed `@opencode-ai/plugin@1.17.15` types:

| Finding | Invalidates | Impact | Resolved? |
|---|---|---|---|
| Events are NOT direct hooks (dispatch through single `event` hook) | Security plan's `turn-context.ts` using `message.updated` as direct hook; master plan's hook inventory descriptions | Security plan's turn-context writer won't compile/work. opencode plan's version uses `chat.message` (a direct hook) — correct. | **Partially** — opencode plan is correct; security plan needs updating. The security plan's external-authority-gate (reader) is unaffected. |
| `args` is in `output` param, not `input` | Nothing — both plans' gate code accesses `input.tool` (correct), and memory-intercept accesses `output.args` (correct) | None | ✓ No impact |
| No `context` field in prompt body | **Gateway plan's `triggerAgent`** and **master plan's design** — both send `context: [...]` | **BLOCKING** — metadata silently dropped. Agent never sees source routing. | **No** — gateway plan and master plan need updating (see Inconsistency 5) |

---

## 6. Feasibility Assessment

### 6.1 Timeline realism

**Verdict: REALISTIC WITH CAVEATS**

The build-order's 232.5h / ~30 working days / 6 weeks estimate is sound for the scoped work. However, the undocumented work adds ~15-25h:

| Undocumented work | Estimated effort |
|---|---|
| 6 new gateway endpoints | ~8-12h |
| Proxy sidecar creation + testing (beyond the plugin) | ~4-6h |
| Bun runtime integration OR proxy rewrite in Node | ~2-4h |
| TypeScript compilation pipeline for workers | ~2-3h |
| Memory-recall plugin | ~3-4h |
| Naming convention reconciliation + updates | ~2-3h |
| **Total additional** | **~21-32h** |

This extends the total to ~254-265h, pushing the timeline to ~6.5 weeks with 3 developers. Still within the "5-6 weeks" range's upper bound if the revision pass resolves inconsistencies before implementation starts.

**If inconsistencies are discovered during implementation** (not before), debugging + rework could add 1 week.

### 6.2 Phase risk ranking

| Phase | Risk level | Primary risk |
|---|---|---|
| **Phase 2.5** | **Highest** | Fail-fast gate. 3 non-negotiable validations (a, c, d). API corrections already showed original assumptions were wrong. If deny/correlation-id/prompt_async fail, migration stops. |
| **Phase 3** | **Second highest** | 73h, 33 tasks. Reconcile worker permission model uncertain. Proxy sidecar is new architecture. 6+ gateway endpoints needed but not scoped. Memory recall missing. |
| **Phase 4.5** | **Third highest** | Two containers running simultaneously = silent duplicate messages. Operational, not code. Well-covered by testing plan's 30-min watch. |
| **Phase 6** | **Fourth** | Behavioral degradation is inherently silent. Alternating-day protocol is slow (7.5 days). Subjective scoring. |
| **Phase 5** | **Medium** | Verification-heavy (17 tasks). Most risks are caught by Phase 2.5 + Phase 3. |
| **Phases 0, 1, 2, 4, 7** | **Low** | Well-scoped, well-tested, rollback paths clear. |

### 6.3 Phase 2.5 validation criteria specificity

**Verdict: PASS — criteria are specific and evidence-based**

| Validation | Pass/fail criterion | Evidence required | Gating? |
|---|---|---|---|
| (a) deny semantics | File `/tmp/test` does NOT exist + agent acknowledges deny + probe log shows deny | `ls /tmp/test` + agent reply + probe log | **Non-negotiable** |
| (b) message.updated granularity | 1 event per turn + complete payload | Probe log event count + payload hash | Assess (workaround exists) |
| (c) correlation-ids | `ll5_audit_log` row has non-null `session_id` + `trace_id` | SQL query result | **Non-negotiable** |
| (d) prompt_async queueing | Second POST returns 202/200 + runs after first | HTTP status code + probe log timestamps | **Non-negotiable** |
| (e) MCP retry | Document retry behavior | Probe log + opencode logs | Not blocking |
| (f) session.compacting | Event fires + `context` array mutable | Probe log + plugin log | Assess |
| (g) session.created | Event in `typesSeen` | Probe `SUMMARY` output | Assess |
| (h) /daily quality | Score ≥ 3/5 on 4 dimensions | Scored rubric + output comparison | Assess |

The criteria are binary where they need to be (a, c, d) and subjective where appropriate (h). The evidence requirements are concrete. The gate decision is unambiguous: (a), (c), or (d) fail → STOP.

**One note**: The opencode plan's API correction changes validation (b) from `message.updated` to `session.idle` as the turn-boundary signal. The testing plan's §2.2 still references `message.updated`. This should be updated, but it doesn't block the gate — the probe script logs ALL events, so whichever event fires at turn boundary will be captured.

---

## 7. Recommendations

### 7.1 Required fixes before implementation (blocking)

1. **Fix `triggerAgent` body format** — Remove `context` field; prepend metadata as a `parts` entry. Update both `impl-gateway-shared.md:643-649` and `dual-run-variant-plan.md:198-203`. (~30 min doc edit)

2. **Add 6 gateway endpoints to gateway plan + build-order** — Scope `POST /internal/ingest-memory`, `GET /internal/regrounding`, `POST /internal/eval-moment`, `POST /internal/activity`, `POST /internal/continuity-probe`, `POST /internal/memory-intercept-log`. Add as Phase 2 tasks (P2-T10 through P2-T15). (~2h doc work)

3. **Fix `render-mcp-config.ts` flag** — Change Dockerfile invocations from `--input` to `--config` in `impl-docker-cicd.md:79-82,175-178`. (~15 min doc edit)

4. **Fix opencode.json render overwrite** — Either (a) render to `/workspace/mcp-rendered.json` and merge at runtime, (b) don't render for opencode (the variant repo's `opencode.json` is hand-maintained with proxy URLs), or (c) implement `--section mcp` merge. Recommendation: option (b) — the opencode variant's MCP config is fundamentally different (proxy URLs, no static headers) and can't be rendered from `mcp-endpoints.json` without proxy-awareness. Remove the render step from `Dockerfile.ll5-run-opencode`. (~30 min doc edit)

5. **Align MCP server naming** — Pick ONE convention. Recommendation: `personal-knowledge`, `gtd`, `awareness`, `google`, `messaging`, `health` (matches opencode plan + current Claude Code `.mcp.server.json` keys minus `ll5-` prefix). Update `mcp-endpoints.json` in gateway plan, security plan's `SAFE_TOOL_PATTERNS` (`pk__` → `personal-knowledge__`), and all cross-references. (~1h doc work)

6. **Fix sessionType naming** — Standardize on underscores (`narrative_loop`, `reconcile_loop`) in all plans. Update master plan:260, opencode plan:1437,1496. (~15 min doc edit)

7. **Fix Bun runtime** — Either add `RUN npm install -g bun` to `Dockerfile.ll5-run-opencode`, OR rewrite `correlation-id-proxy.ts` using Node's `http` module. Recommendation: rewrite in Node — avoids a second runtime dependency. (~1h code + doc)

8. **Fix TypeScript compilation** — Either (a) change entrypoint to use `npx tsx /workspace/scripts/*.ts`, or (b) add a `RUN npx tsc` step to the Dockerfile. Recommendation: use `npx tsx` in the entrypoint — simplest, no separate compile step. (~30 min doc edit)

### 7.2 Recommended fixes before implementation (non-blocking but important)

9. **Add memory-recall plugin** — Create a `memory-recall.ts` plugin using `experimental.chat.messages.transform` or `chat.message` hook to call `recall_lessons` and prepend context. Add build-order task P3-T14.5. (~1h doc + 3h implementation)

10. **Align reconcile worker permission approach** — Both plans should agree on plugin-level enforcement (`reconcile-gate.ts`) as the PRIMARY mechanism, with config-level permissions as defense-in-depth. Update security plan §2c and opencode plan §3.7. (~1h doc work)

11. **Update security plan's turn-context.ts** — Change from `message.updated` direct hook to `chat.message` direct hook (matching opencode plan §3.4.7). (~15 min doc edit)

12. **Add `OPENCODE_VERSION` to build-order P4-T8** — The Docker plan lists this secret but the build-order doesn't. (~5 min doc edit)

13. **Add proxy sidecar task to build-order** — P3-T5 covers the plugin; add P3-T5b for the proxy script itself. (~10 min doc work)

14. **Update testing plan §2.2** — Change `message.updated` to `session.idle` as the turn-boundary signal (matching opencode plan's API correction). (~15 min doc edit)

### 7.3 Revision pass estimate

| Work item | Time |
|---|---|
| Fixes 1-8 (blocking) | ~4h |
| Fixes 9-14 (recommended) | ~2.5h |
| Cross-check after fixes | ~1h |
| **Total revision pass** | **~7.5h** |

---

## 8. Summary Table

| Criterion | Verdict | Blocking issues |
|---|---|---|
| 1. Cross-document consistency | **FAIL** | 6 inconsistencies (4 blocking) |
| 2. Completeness | **FAIL** | 6 undocumented gateway endpoints; 3 missing components; 1 missing hook |
| 3. Dependency integrity | **PASS** | 3 hidden dependencies (2 runtime blockers) |
| 4. Security coverage | **FAIL** | Reconcile permission approach mismatch; hook #6 missing |
| 5. Critical gaps | **FAIL** | 8 blocking gaps; API finding #3 invalidates gateway plan |
| 6. Feasibility | **PASS** | Timeline realistic (+1 week if gaps not fixed first); Phase 2.5 criteria sufficient |

**Bottom line**: The architectural design is strong — the shared/variant split, fail-fast gate, single-var rollback, per-responsibility bridge mapping, and proxy sidecar for correlation-ids are all well-reasoned. The Senior Developer's API corrections are invaluable. But the plans were written by separate agents that didn't fully synchronize on naming conventions, the opencode API's actual type surface, and the gateway endpoints the plugins depend on. One focused revision pass (~7.5h of doc work) would resolve all blocking issues and make these plans ready for implementation.
