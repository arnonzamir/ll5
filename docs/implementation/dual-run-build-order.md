# Dual Run-Variant Build Order

Project management document for the dual run-variant migration. Derived from
`dual-run-variant-plan.md` (v2, post-review). Baseline timeline: **5-6 weeks**
(the review's corrected estimate, not v1's 2.5 weeks).

**System context**: 532 commits, 161 test files, live production deployment on
Coolify. Silent failures are the dominant risk class (37h silent scheduler
breakage, 8-day silent ES write death). Every phase must include silent-failure
detection.

---

## 1. Dependency Graph

### Phase 0: Rename ll5-run → ll5-run-claude-code

| Dependency type | Phases |
|---|---|
| **Hard** | None |
| **Soft** | None |
| **Can start** | Immediately |

### Phase 1: Extract shared content to ll5

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 0 (need renamed repo to extract from) |
| **Soft** | None |
| **Can start** | After Phase 0 |

### Phase 2: Gateway agent-trigger abstraction

| Dependency type | Phases |
|---|---|
| **Hard** | None (gateway code is variant-agnostic) |
| **Soft** | Phase 1 (shared content informs what metadata variants need) |
| **Can start** | Immediately (parallel with Phase 0) |

### Phase 2.5: Thin vertical slice — FAIL FAST GATE

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 2 (needs `triggerAgent`, `/internal/agent-session` endpoint) |
| **Soft** | None |
| **Can start** | After Phase 2 |

### Phase 3: Create ll5-run-opencode repo

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 2.5 (must pass fail-fast gate before 2-week investment) |
| **Soft** | Phase 1 (shared content for MCP config rendering) |
| **Can start** | After Phase 2.5 passes |

### Phase 4: Dockerfiles + CI

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 1 (shared content must exist for Docker COPY), Phase 3 (variant content must exist for Docker COPY) |
| **Soft** | None |
| **Can start** | After both Phase 1 AND Phase 3 complete |

### Phase 4.5: Standalone → compose transition

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 4 (need Dockerfile + CI to build claude image) |
| **Soft** | None |
| **Can start** | After Phase 4 |

### Phase 5: Compose + deploy opencode variant

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 4.5 (compose transition done), Phase 3 (opencode variant built), Phase 4 (opencode Dockerfile + CI) |
| **Soft** | None |
| **Can start** | After Phase 4.5 |

### Phase 6: Behavioral parity testing + persona tuning

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 5 (opencode variant deployed and working) |
| **Soft** | None |
| **Can start** | After Phase 5 |

### Phase 7: Cutover

| Dependency type | Phases |
|---|---|
| **Hard** | Phase 6 (parity testing passes) |
| **Soft** | None |
| **Can start** | After Phase 6 |

### Dependency graph (visual)

```
                    ┌─────────────────────────────────────────────────────────┐
                    │                                                         │
 Phase 0            │                                                         │
 (rename)           │                                                         │
   │                │                                                         │
   ▼                │                                                         │
 Phase 1            │                                                         │
 (extract shared)   │                                                         │
   │                │                                                         │
   │                │           Phase 2                                       │
   │                │           (gateway trigger)                             │
   │                │              │                                          │
   │                │              ▼                                          │
   │                │           Phase 2.5 ←── FAIL FAST GATE                  │
   │                │           (thin slice)                                  │
   │                │              │                                          │
   │                │              ▼                                          │
   │                │           Phase 3                                       │
   │                │           (opencode repo)                               │
   │                │              │                                          │
   ▼                │              ▼                                          │
 Phase 4 ◄──────────┴──────────────┘                                         │
 (Dockerfiles + CI)                                                          │
   │                                                                         │
   ▼                                                                         │
 Phase 4.5                                                                   │
 (compose transition)                                                        │
   │                                                                         │
   ▼                                                                         │
 Phase 5                                                                     │
 (deploy opencode)                                                           │
   │                                                                         │
   ▼                                                                         │
 Phase 6                                                                     │
 (parity + persona)                                                          │
   │                                                                         │
   ▼                                                                         │
 Phase 7                                                                     │
 (cutover)                                                                   │
```

---

## 2. Build Order

### Parallel tracks

Two independent tracks feed into Phase 4:

| Track | Chain | Duration | Notes |
|---|---|---|---|
| **Track A** (content) | 0 → 1 | 4 working days | Rename + shared extraction |
| **Track B** (gateway + validation) | 2 → 2.5 → 3 | 15 working days | Gateway trigger, fail-fast, opencode build |

Track A finishes at day 4. Track B finishes at day 15. Phase 4 starts at day 15
(the longer chain gates it).

### Sequential constraints

| Constraint | Reason |
|---|---|
| 0 → 1 | Shared content extraction requires the renamed repo |
| 2 → 2.5 | Fail-fast slice needs the trigger + endpoint |
| 2.5 → 3 | 2-week build investment gated on validated assumptions |
| (1, 3) → 4 | Both shared + variant content needed for Docker build |
| 4 → 4.5 | Need CI-built image before compose transition |
| 4.5 → 5 | Compose transition must be clean before opencode deploy |
| 5 → 6 | Can't test parity until opencode is live |
| 6 → 7 | Can't cutover until parity is verified |

### Critical path

```
Phase 2 → Phase 2.5 → Phase 3 → Phase 4 → Phase 4.5 → Phase 5 → Phase 6 → Phase 7
  2d        3d         10d       3d        1d          2d       7.5d      1d
                                                                              = 29.5 working days
```

Track A (0→1, 4d) runs in parallel and completes well before Phase 4 starts.

**Total elapsed time: ~30 working days ≈ 6 weeks** (conservative; the plan's
"5-6 weeks" range accounts for overlap and buffer).

### Fail-fast gate (Phase 2.5)

Phase 2.5 is the **investment decision boundary**. It blocks:

| If 2.5 passes | If 2.5 fails |
|---|---|
| Phase 3 proceeds (2-week opencode build) | Phase 3+ cancelled. Phases 0-2 are retained (shared content, gateway trigger abstraction). Architecture is ready for a different agent runtime if one emerges. |
| ~$0 sunk cost beyond Phases 0-2 | ~$0 sunk cost beyond Phases 0-2 |
| Total effort continues to ~5 weeks | Total effort stops at ~1.5 weeks |

The gate validates 8 specific assumptions (see Phase 2.5 tasks). Each must pass
with evidence (probe script output, not assertions).

---

## 3. Task Breakdown

### Phase 0: Rename ll5-run → ll5-run-claude-code

**Duration**: 1 day (~7.5h)
**Owner**: DevOps engineer

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P0-T1 | Rename GitHub repo `ll5-run` → `ll5-run-claude-code` | 0.5h | — | GitHub repo URL reflects new name; old URL redirects | GitHub settings |
| P0-T2 | Update local remotes for all clones | 0.5h | P0-T1 | `git remote -v` shows new URL in all working copies | local git config |
| P0-T3 | Update ll5-run-claude-code CI to push as `ghcr.io/arnonzamir/ll5-run-claude:latest` | 1h | P0-T1 | CI workflow references new image tag; build succeeds | `.github/workflows/*.yml` in ll5-run-claude-code |
| P0-T4 | Update doc references in ll5 (FILE_TREE.md, HANDOFF.md, PROGRESS.md) | 1h | P0-T1 | No remaining `ll5-run` references (except historical context) | `docs/FILE_TREE.md`, `docs/HANDOFF.md`, `docs/PROGRESS.md` |
| P0-T5 | Update PAT scopes (`LL5_DISPATCH_PAT`, `VARIANT_REPO_READ_PAT`) | 0.5h | P0-T1 | PATs have read access to new repo name | GitHub secrets |
| P0-T6 | Build + push new image, verify end-to-end | 2h | P0-T3, P0-T5 | `docker pull ghcr.io/arnonzamir/ll5-run-claude:latest` succeeds; image runs | CI |
| P0-T7 | Swap container on host, retire old image name | 1h | P0-T6 | Old `ll5-agent` container stopped; new container running from `ll5-run-claude` image | host Docker |
| P0-T8 | Verify Claude Code agent works end-to-end with new image | 1h | P0-T7 | Send test message, agent responds; MCP tools work; check audit log for correlation-ids | — |

**Phase 0 total**: 7.5h

---

### Phase 1: Extract shared content to ll5

**Duration**: 2-3 days (~18h)
**Owner**: Senior developer + backend architect (for render script)

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P1-T1 | Create `packages/ll5-run-shared/` directory structure | 0.5h | P0-T7 | Directory exists with subdirs: `skills/`, `prompts/` | `packages/ll5-run-shared/` |
| P1-T2 | Move `CLAUDE.md` to `packages/ll5-run-shared/CLAUDE.md` | 0.5h | P1-T1 | File copied; content unchanged | `packages/ll5-run-shared/CLAUDE.md` |
| P1-T3 | Move 17 skills to `packages/ll5-run-shared/skills/` | 1h | P1-T1 | All 17 `SKILL.md` files present; structure mirrors `.claude/skills/` | `packages/ll5-run-shared/skills/*/SKILL.md` |
| P1-T4 | Move prompts to `packages/ll5-run-shared/prompts/` | 0.5h | P1-T1 | `narrative-loop.md`, `reconcile-loop.md` present | `packages/ll5-run-shared/prompts/*.md` |
| P1-T5 | Move `.mcp.server.json` → `mcp-endpoints.json` | 0.5h | P1-T1 | JSON structure defines 6 remote MCPs with URLs + auth; valid JSON | `packages/ll5-run-shared/mcp-endpoints.json` |
| P1-T6 | Audit `CLAUDE.md` and skills for path references to ll5-run-specific locations | 2h | P1-T2, P1-T3 | All `~/.ll5/`, hook paths, `get-mcp-auth.sh`, `scripts/` references identified and documented | audit notes |
| P1-T7 | Update path references to work from both shared and rendered locations | 2h | P1-T6 | No hardcoded path that breaks in Docker context; references use env vars or relative paths | `packages/ll5-run-shared/CLAUDE.md`, skills |
| P1-T8 | Create `scripts/render-mcp-config.ts` — Claude Code format | 3h | P1-T5 | Reads `mcp-endpoints.json`, emits `.claude/settings.json` with `headersHelper` pointing to `get-mcp-auth.sh`; unit tested | `scripts/render-mcp-config.ts` |
| P1-T9 | Extend `render-mcp-config.ts` for opencode format | 2h | P1-T8 | Emits `opencode.json` with `mcp` section + static headers; unit tested | `scripts/render-mcp-config.ts` |
| P1-T10 | Update ll5-run-claude-code CI to copy shared content (not symlinks) | 1h | P1-T2, P1-T3, P1-T4 | CI copies shared content into build context; Docker build succeeds | `.github/workflows/*.yml` in ll5-run-claude-code |
| P1-T11 | Add `ll5-run-shared` to change-detection in `build-and-push.yml` | 1h | P1-T1 | Changes to `packages/ll5-run-shared/` trigger agent variant rebuild | `.github/workflows/build-and-push.yml` |
| P1-T12 | Keep ll5-run-claude-code's in-repo copy as fallback | 0.5h | P1-T10 | Fallback copy exists; not deleted until verification | ll5-run-claude-code repo |
| P1-T13 | Build + verify Claude Code agent with content sourced from ll5 | 2h | P1-T10, P1-T11 | Agent runs; persona present (check CLAUDE.md loaded); skills available (test `/daily`); **watch for silent degradation** — agent runs but behaves wrong | CI + host |
| P1-T14 | Delete fallback copy after verification | 0.5h | P1-T13 | In-repo copy removed from ll5-run-claude-code; single source of truth in ll5 | ll5-run-claude-code repo |
| P1-T15 | Update PROGRESS.md, HANDOFF.md, FILE_TREE.md | 1h | P1-T14 | Docs reflect new shared content location | `docs/PROGRESS.md`, `docs/HANDOFF.md`, `docs/FILE_TREE.md` |

**Phase 1 total**: 18h
**Key risk**: Silent persona degradation — agent runs but with missing/stale persona or skills (path references wrong).

---

### Phase 2: Gateway agent-trigger abstraction

**Duration**: 1-2 days (~14h)
**Owner**: Backend architect
**Can run in parallel with**: Phase 0, Phase 1

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P2-T1 | Create migration 039: `agent_session_id` (nullable text) + `agent_sessions` JSONB on `user_settings` | 1h | — | Migration applies cleanly on production DB; existing data preserved; `agent_session_id` column is nullable | `packages/gateway/src/migrations/039_agent_session.sql` |
| P2-T2 | Create `packages/gateway/src/utils/agent-trigger.ts` | 3h | — | Exports `triggerAgent(sessionId, payload)`; no-op when `OPENCODE_SERVER_URL` empty; HTTP POST when set; full metadata payload (source routing, scheduler event); throws on failure (does not swallow) | `packages/gateway/src/utils/agent-trigger.ts` |
| P2-T3 | Add `POST /internal/agent-session` endpoint | 2h | P2-T1 | Accepts `{ sessionId, sessionType }`; updates `user_settings.agent_sessions` JSON map; auth-protected; tenant-scoped; tested | `packages/gateway/src/server.ts` or route file |
| P2-T4 | Add `getAgentSessionId(pool, userId, sessionType?)` helper | 1h | P2-T1 | Reads `user_settings.agent_sessions[sessionType]` or `agent_session_id`; returns null if not set; tested | `packages/gateway/src/utils/agent-trigger.ts` |
| P2-T5 | Modify `insertSystemMessage` to call `triggerAgent` when `OPENCODE_SERVER_URL` set | 1.5h | P2-T2, P2-T4 | `triggerAgent` called after PG insert succeeds; passes full metadata; `.catch()` marks row for sweep retry; no behavioral change when env empty | `packages/gateway/src/utils/system-message.ts` |
| P2-T6 | Modify `stuck-message-sweep` pass A to call `triggerAgent` alongside `pg_notify` | 1.5h | P2-T2, P2-T5 | Re-notified rows also call `triggerAgent`; serves as redelivery mechanism | `packages/gateway/src/scheduler/stuck-message-sweep.ts` |
| P2-T7 | Update `system-message.test.ts` | 2h | P2-T5 | Fetch stubs prevent network calls; `triggerAgent` mocked; tests cover: env empty (no-op), env set (calls fetch), fetch failure (row marked for retry); cross-tenant negative test | `packages/gateway/src/__tests__/system-message.test.ts` |
| P2-T8 | Update `stuck-message-sweep.test.ts` | 1.5h | P2-T6 | Fetch stubs; `triggerAgent` mocked; tests cover: sweep re-notifies + triggers; env empty (no trigger) | `packages/gateway/src/__tests__/stuck-message-sweep.test.ts` |
| P2-T9 | Run full gateway test suite | 0.5h | P2-T7, P2-T8 | All 700+ tests pass; no regressions | — |

**Phase 2 total**: 14h
**Note**: Existing tables `agent_runtimes` (migration 030) and `agent_credentials` (migration 031) already exist from the BYO-agent tenant platform design. Migration 039 adds session mapping to `user_settings` — do NOT duplicate into `agent_runtimes` unless the design explicitly merges them.

**Deploy gate**: P2-T9 must pass before deploying. Deploy with `OPENCODE_SERVER_URL` empty — verify Claude Code variant is completely unaffected. The trigger is a no-op when the env var is empty.

---

### Phase 2.5: Thin vertical slice — FAIL FAST GATE

**Duration**: 3 days (~26h)
**Owner**: Senior developer + security engineer
**Cannot start until**: Phase 2 deployed

This is the **critical de-risking phase**. Before building all 12 plugins + 3
workers, validate the core assumptions with a minimal vertical slice.

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P2.5-T1 | Pin opencode version; document exact version + commit hash | 1h | — | Version pinned in a doc; reproducible install | `docs/implementation/opencode-version-pin.md` |
| P2.5-T2 | Create minimal opencode project scaffold | 1h | P2.5-T1 | `opencode.json` with 1 MCP (messaging); `.opencode/plugins/` dir; runnable | local scaffold |
| P2.5-T3 | Port `memory-intercept.ts` plugin (minimal) | 2h | P2.5-T2 | Plugin loads; intercepts write/edit → calls `ingest_memory` → denies original | `.opencode/plugins/memory-intercept.ts` |
| P2.5-T4 | Port `push_to_user` in `ll5-channel.ts` plugin (minimal) | 2h | P2.5-T2 | Custom tool calls gateway `POST /chat/messages`; message appears in PG | `.opencode/plugins/ll5-channel.ts` |
| P2.5-T5 | Port `correlation-id-injector.ts` plugin (minimal) | 3h | P2.5-T2 | Injects `X-LL5-Session-Id` + `X-LL5-Trace-Id` headers into MCP tool calls; headers land in `ll5_audit_log` | `.opencode/plugins/correlation-id-injector.ts` |
| P2.5-T6 | Port `session-history.ts` plugin (minimal) | 2h | P2.5-T2 | `message.updated` event → POST to `/sessions` → ES `ll5_session_history` doc | `.opencode/plugins/session-history.ts` |
| P2.5-T7 | Write probe script logging every event for one turn | 2h | P2.5-T2 | Script logs: event name, timestamp, payload shape, granularity; run output saved as evidence | `scripts/probe-events.ts` |
| **Validation (a)** | `tool.execute.before` deny semantics match bash PreToolUse deny | 1.5h | P2.5-T3, P2.5-T7 | Tool call is actually blocked (not just intercepted); agent receives deny message; probe confirms | — |
| **Validation (b)** | `message.updated` gives complete turns (not partial) | 1.5h | P2.5-T6, P2.5-T7 | Event fires at turn boundary; payload is complete turn (not fragment); probe confirms | — |
| **Validation (c)** | Correlation-id headers can be injected into MCP calls | 2h | P2.5-T5, P2.5-T7 | Headers visible in `ll5_audit_log` rows; if opencode doesn't support dynamic headers, shim works; probe confirms | — |
| **Validation (d)** | `prompt_async` queueing on mid-turn session | 1.5h | P2.5-T4, P2.5-T7 | opencode queues (not rejects, not interleaves); second prompt runs after first completes; probe confirms | — |
| **Validation (e)** | opencode's MCP retry behavior | 1.5h | P2.5-T7 | Document whether opencode retries failed HTTP MCPs natively; if not, autoheal is needed; probe confirms | — |
| **Validation (f)** | `experimental.session.compacting` event fires and is usable | 1h | P2.5-T7 | Event fires on compaction; payload includes session state; probe confirms | — |
| **Validation (g)** | `session.created` event fires on new session | 0.5h | P2.5-T7 | Event fires; payload includes session ID; probe confirms | — |
| **Validation (h)** | `/daily` skill executes with acceptable behavioral quality | 2h | P2.5-T3, P2.5-T4 | Skill runs; output is coherent; persona adherence acceptable (not perfect, but not broken); document quality issues | — |
| P2.5-T8 | Decision document: pass or fail with evidence | 1h | all validations | Document with probe output for each validation; explicit pass/fail per assumption; if fail, what stopped it | `docs/implementation/phase-2.5-gate-result.md` |

**Phase 2.5 total**: 26h

**Gate decision**: If ANY of validations (a), (c), or (d) fail → STOP. These are
non-negotiable:
- (a) deny semantics: security boundary depends on it
- (c) correlation-ids: audit ledger + reconcile governor go blind without it
- (d) prompt_async: gateway can't trigger the agent without it

If (b), (e), (f), (g), or (h) fail → assess individually; some have workarounds.

---

### Phase 3: Create ll5-run-opencode repo

**Duration**: 2 weeks (~73h)
**Owner**: Senior developer (plugins), backend architect (workers + config), security engineer (external-authority-gate, reconcile)
**Cannot start until**: Phase 2.5 passes

#### P0 plugins (validated in Phase 2.5)

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T1 | Create `ll5-run-opencode` repo on GitHub | 0.5h | P2.5-T8 (pass) | Repo exists; default branch protected; CI skeleton | GitHub |
| P3-T2 | Set up repo structure (`.opencode/`, `scripts/`, `opencode.json`) | 1h | P3-T1 | Directory structure mirrors plan; `package.json` with opencode SDK dep | repo scaffold |
| P3-T3 | Port `memory-intercept.ts` (production version) | 2h | P3-T2, P2.5-T3 | Full logic: intercept write/edit → `ingest_memory` → deny; edge cases handled; tested | `.opencode/plugins/memory-intercept.ts` |
| P3-T4 | Port `external-authority-gate.ts` (security-critical) | 4h | P3-T2 | **Port exact safe-tool allowlist from bash hook**; deny state-changing tools on externally-triggered turns (Hard Rule 13); adversarial review by security engineer; tested with attack vectors | `.opencode/plugins/external-authority-gate.ts` |
| P3-T5 | Port `correlation-id-injector.ts` (production) | 3h | P3-T2, P2.5-T5 | Injects headers into all MCP tool calls; works with all 6 remote MCPs; shim if needed from 2.5; tested | `.opencode/plugins/correlation-id-injector.ts` |
| P3-T6 | Port `session-history.ts` (with turn-boundary dedup) | 3h | P3-T2, P2.5-T6 | `message.updated` → POST to `/sessions`; turn-boundary dedup (NOT `message.part.updated`); tested with multi-turn sessions | `.opencode/plugins/session-history.ts` |
| P3-T7 | Build `ll5-channel.ts` (5 outbound tools) | 6h | P3-T2, P2.5-T4 | `push_to_user`, `narrate`, `react`, `new_conversation`, `check_mcp_connectivity`; each calls correct gateway REST endpoint; tested | `.opencode/plugins/ll5-channel.ts` |

#### P1 plugins

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T8 | Port `cron-block.ts` | 1.5h | P3-T2 | Deny scheduling tools; tested | `.opencode/plugins/cron-block.ts` |
| P3-T9 | Port `repo-write-block.ts` | 1.5h | P3-T2 | Deny writes to workspace; tested | `.opencode/plugins/repo-write-block.ts` |
| P3-T10 | Port `stop-mirror.ts` (with posted-ledger dedup) | 4h | P3-T2 | `session.idle` event → surface agent prose; read posted-ledger, skip if already posted; shared state file; tested | `.opencode/plugins/stop-mirror.ts` |
| P3-T11 | Port `session-start.ts` (full re-grounding) | 6h | P3-T2 | `session.created` → re-grounding (narratives + sessions + knowledge + lessons + journal; source=compact branch); calls gateway auth for token check; tested | `.opencode/plugins/session-start.ts` |
| P3-T12 | Port `compaction.ts` (experimental.session.compacting) | 3h | P3-T2 | Inject re-grounding context before compaction; tested | `.opencode/plugins/compaction.ts` |
| P3-T13 | Port `precompact-backup.ts` | 2h | P3-T2 | Backup session before compaction; tested | `.opencode/plugins/precompact-backup.ts` |
| P3-T14 | Port `turn-context.ts` | 3h | P3-T2 | Track `expects_user_reply` per inbound; write to shared state file; used by stop-mirror; tested | `.opencode/plugins/turn-context.ts` |

#### P2 plugins

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T15 | Port `eval-recorder.ts` | 2h | P3-T2 | `session.idle` event (NOT `message.part.updated`); turn-boundary dedup; curl telemetry/eval-moment per turn; tested | `.opencode/plugins/eval-recorder.ts` |
| P3-T16 | Port `activity-marker.ts` | 2h | P3-T2 | `tool.execute.after`; live compact activity rows; allowlist; tested | `.opencode/plugins/activity-marker.ts` |
| P3-T17 | Port `narration-watchdog.ts` | 2h | P3-T2 | `tool.execute.after`; narrative loop liveness; tested | `.opencode/plugins/narration-watchdog.ts` |
| P3-T18 | Port `file-changed.ts` | 1.5h | P3-T2 | `tool.execute.after`; file change tracking; tested | `.opencode/plugins/file-changed.ts` |

#### SDK workers

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T19 | Port `narrative-loop.ts` | 4h | P3-T2 | `createOpencodeClient` → `session.create` → `session.prompt`; headless background worker; tested | `scripts/narrative-loop.ts` |
| P3-T20 | Port `reconcile-loop.ts` + security tests | 6h | P3-T2 | SDK-based restricted agent; security test port (`test_reconcile_security.py` → TS tests); verify opencode permissions are **allowlist/deny-by-default, not bypassable via subagent**; 28+ security checks green; adversarial review | `scripts/reconcile-loop.ts`, `scripts/__tests__/reconcile-security.test.ts` |
| P3-T21 | Port `autoheal.ts` (conditional) | 3h | P3-T2, P2.5 (e) | Only if Phase 2.5 showed opencode doesn't retry MCPs natively; SDK-based MCP health watch → session restart; tested | `scripts/autoheal.ts` |
| P3-T22 | Port `continuity-probe.ts` | 2h | P3-T2 | SDK-based session continuity grading; tested | `scripts/continuity-probe.ts` |
| P3-T23 | Port `session-backup.ts` | 2h | P3-T2 | SDK-based session backup to ES; tested | `scripts/session-backup.ts` |

#### Config + entrypoint

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T24 | Create `opencode.json` | 3h | P3-T5, P3-T7 | MCP config (rendered from `mcp-endpoints.json`), agent configs, permissions (allowlist), model selection; valid | `opencode.json` |
| P3-T25 | Create `.opencode/agents/narrative-consolidator.md` | 1h | P3-T2 | Subagent definition in opencode format; same intent as Claude Code version | `.opencode/agents/narrative-consolidator.md` |
| P3-T26 | Create `.opencode/agents/grounding-reviewer.md` | 1h | P3-T2 | Subagent: durable forward-facing work verification (Hard Rule 12) | `.opencode/agents/grounding-reviewer.md` |
| P3-T27 | Create `.opencode/agents/reconcile-worker.md` | 1.5h | P3-T2 | Reconcile worker (restricted via per-agent permissions — allowlist); tested | `.opencode/agents/reconcile-worker.md` |
| P3-T28 | Create `docker-entrypoint.sh` | 2h | P3-T19, P3-T20 | Starts `opencode serve` + worker scripts + session registration via `/internal/agent-session`; writes `healthcheck.sh` on startup | `docker-entrypoint.sh`, `healthcheck.sh` |
| P3-T29 | Create `healthcheck.sh` | 0.5h | P3-T28 | `wget -qO- http://localhost:4096/health`; exits 0 on success | `healthcheck.sh` |
| P3-T30 | Add CI workflow `trigger-ll5-rebuild.yml` | 1h | P3-T1 | `repository_dispatch` to ll5 on push; weekly scheduled fallback | `.github/workflows/trigger-ll5-rebuild.yml` |

#### Verification

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P3-T31 | Local verify: run opencode with remote MCPs, execute each skill | 4h | all plugins | Each of 17 skills executes; tool calls work; no plugin errors | — |
| P3-T32 | Confirm correlation-ids in audit ledger | 1h | P3-T5, P3-T31 | `ll5_audit_log` rows have `session_id` + `trace_id` populated | — |
| P3-T33 | Verify reconcile worker security tests pass | 2h | P3-T20 | All 28+ security checks green; allowlist not bypassable | — |

**Phase 3 total**: 73h

---

### Phase 4: Dockerfiles + CI

**Duration**: 2-3 days (~16h)
**Owner**: DevOps engineer
**Cannot start until**: Phase 1 AND Phase 3 complete

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P4-T1 | Create `docker/Dockerfile.ll5-run-claude` | 2h | P1-T14 | Dockerfile: node:20-slim, tmux, Claude Code CLI, shared content COPY, variant content COPY, render MCP config, `$HOME=/data/home`, entrypoint; builds locally | `docker/Dockerfile.ll5-run-claude` |
| P4-T2 | Create `docker/Dockerfile.ll5-run-opencode` | 2h | P3-T28 | Dockerfile: node:20-slim, pinned opencode version, shared content COPY, variant content COPY, render MCP config, npm install plugins, `$HOME=/data/home`, expose 4096, entrypoint; builds locally | `docker/Dockerfile.ll5-run-opencode` |
| P4-T3 | Add `run-claude` and `run-opencode` to build matrix in `detect-changes` | 1h | P4-T1, P4-T2 | Package list includes `run-claude`, `run-opencode`; change-detection triggers on variant repo dispatch | `.github/workflows/build-and-push.yml` |
| P4-T4 | Add Node step skip conditions for `run-*` packages | 1h | P4-T3 | `setup-node`, `npm ci`, `build shared`, `typecheck`, `build target` all skip for `startsWith(matrix.package, 'run-')` | `.github/workflows/build-and-push.yml` |
| P4-T5 | Add variant repo checkout step | 1.5h | P4-T3 | `actions/checkout@v4` with `repository: arnonzamir/ll5-${{ matrix.package }}-code`, `path: variant-content`, `token: VARIANT_REPO_READ_PAT`; only for `run-*` packages | `.github/workflows/build-and-push.yml` |
| P4-T6 | Add Dockerfile selection for variant packages | 1h | P4-T3 | `case` statement maps `run-claude` → `docker/Dockerfile.ll5-run-claude`, `run-opencode` → `docker/Dockerfile.ll5-run-opencode` | `.github/workflows/build-and-push.yml` |
| P4-T7 | Add `repository_dispatch` handler + weekly scheduled fallback | 2h | P4-T3 | `on: repository_dispatch` with `client_payload.package`; weekly cron `workflow_dispatch` fallback rebuilds both variants | `.github/workflows/build-and-push.yml` |
| P4-T8 | Add GitHub secrets | 0.5h | — | `AGENT_VARIANT`, `OPENCODE_ZEN_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `VARIANT_REPO_READ_PAT`, `LL5_DISPATCH_PAT` set in repo settings | GitHub secrets |
| P4-T9 | Build + verify both images push to GHCR | 4h | P4-T1–P4-T7 | `ghcr.io/arnonzamir/ll5-run-claude:latest` and `ghcr.io/arnonzamir/ll5-run-opencode:latest` both pull successfully; images run | CI |
| P4-T10 | Update PROGRESS.md, HANDOFF.md, FILE_TREE.md | 1h | P4-T9 | Docs reflect new Dockerfiles, CI matrix, image names | `docs/PROGRESS.md`, `docs/HANDOFF.md`, `docs/FILE_TREE.md` |

**Phase 4 total**: 16h

---

### Phase 4.5: Standalone → compose transition

**Duration**: 1 day (~7.5h)
**Owner**: DevOps engineer
**Cannot start until**: Phase 4 complete
**This is the highest-risk operational step.**

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P4.5-T1 | `docker stop` old standalone agent container | 0.5h | P4-T9 | Container stopped; `docker ps` shows no agent container | host |
| P4.5-T2 | `docker rm` old standalone agent container | 0.5h | P4.5-T1 | Container removed; `docker ps -a` shows no old agent | host |
| P4.5-T3 | Copy workspace data from old volume to new `agent-workspace-claude` volume | 1h | P4.5-T2 | `docker run --rm -v old:/from -v new:/to alpine cp -a /from/. /to/`; verify file count matches | host |
| P4.5-T4 | Disable/delete old Coolify app (`js8owk0g0cgog800ckc8ww0s`) | 1h | P4.5-T2 | Coolify app deleted; **prevents Coolify from restarting it**; verify no auto-restart | Coolify UI |
| P4.5-T5 | Verify only one agent container exists | 0.5h | P4.5-T4 | `docker ps \| grep agent` shows exactly one container (the compose one) | host |
| P4.5-T6 | Deploy with `AGENT_VARIANT=claude`, verify end-to-end | 3h | P4.5-T3, P4.5-T5 | Agent container starts via compose; Claude Code works; MCP tools work; send test message, agent responds; check audit log | host + CI |
| P4.5-T7 | Document transition in `deployment-log.md` | 1h | P4.5-T6 | What was done, what was verified, what to watch for | `docs/implementation/deployment-log.md` |

**Phase 4.5 total**: 7.5h
**Critical check**: After P4.5-T4, monitor for 30 minutes that Coolify does NOT
restart the old container. If it does, the old Coolify app was not properly
disabled — two agent containers running is the silent failure mode (both respond
to PG NOTIFY, duplicate messages).

---

### Phase 5: Compose + deploy opencode variant

**Duration**: 1-2 days (~14h)
**Owner**: DevOps engineer + backend architect (verification)
**Cannot start until**: Phase 4.5 complete

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P5-T1 | Add `agent` service to `docker/docker-compose.prod.yml` | 1.5h | P4.5-T6 | Service block parameterized by `AGENT_VARIANT`; volumes: `agent-workspace-${AGENT_VARIANT}`, `agent-home`; no ports published; `depends_on: gateway`; healthcheck variant-specific; `traefik.enable=false` | `docker/docker-compose.prod.yml` |
| P5-T2 | Add `OPENCODE_SERVER_URL` to gateway env block | 0.5h | P5-T1 | `OPENCODE_SERVER_URL: ${OPENCODE_SERVER_URL:-}` in gateway environment | `docker/docker-compose.prod.yml` |
| P5-T3 | Add new env vars to deploy script injection | 1h | P5-T1 | `AGENT_VARIANT`, `OPENCODE_SERVER_URL` (derived), `CLAUDE_CODE_OAUTH_TOKEN`, `OPENCODE_ZEN_API_KEY` injected via idempotent pattern | deploy script in CI |
| P5-T4 | Add agent image to deploy pull loop | 0.5h | P5-T1 | `docker pull ghcr.io/arnonzamir/ll5-run-${AGENT_VARIANT}:latest` in deploy script | deploy script |
| P5-T5 | Add agent health check to deploy job | 1h | P5-T1 | `docker compose ps agent \| grep -q "Up"` after compose up; fails loudly if agent not running | deploy script |
| P5-T6 | Deploy with `AGENT_VARIANT=opencode` | 1h | P5-T1–P5-T5 | Deploy succeeds; agent container running | host + CI |
| P5-T7 | Verify opencode server starts on port 4096 (internal) | 0.5h | P5-T6 | `docker exec agent wget -qO- http://localhost:4096/health` returns 200 | host |
| P5-T8 | Verify session registration via `/internal/agent-session` | 0.5h | P5-T6 | `user_settings.agent_sessions` has `main` session ID populated | PG |
| P5-T9 | Verify gateway triggers reach agent | 1h | P5-T6, P5-T8 | Send test system message; agent receives it via `POST /session/:id/prompt_async`; agent processes | host |
| P5-T10 | Verify full metadata reaches agent | 0.5h | P5-T9 | Source routing + scheduler event metadata visible in agent context | host |
| P5-T11 | Verify all 6 remote MCPs work | 2h | P5-T6 | Test each: personal-knowledge, gtd, awareness, google, messaging, health; tool calls succeed | host |
| P5-T12 | Verify correlation-ids in `ll5_audit_log` | 0.5h | P5-T11 | Audit log rows have `session_id` + `trace_id` from opencode plugin injection | PG/ES |
| P5-T13 | Verify at least one skill works (`/daily` or `/review`) | 1h | P5-T11 | Skill executes; output is coherent; persona present | host |
| P5-T14 | Verify `push_to_user` reaches gateway | 0.5h | P5-T9 | Agent calls `push_to_user` tool; message appears in PG `chat_messages` | PG |
| P5-T15 | Verify `external-authority-gate` blocks state-changing tools | 1h | P5-T9 | Externally-triggered turn + state-changing tool call → denied; agent receives deny message | host |
| P5-T16 | Verify background workers start + complete a cycle | 1h | P5-T6 | narrative-loop + reconcile-loop workers start; create own sessions via `/internal/agent-session` with `sessionType`; complete at least one cycle | host |
| P5-T17 | Verify `session-history` writes to ES `ll5_session_history` | 0.5h | P5-T9 | ES has new `ll5_session_history` docs from opencode turns; `recall_everything` finds them | ES |

**Phase 5 total**: 14h

---

### Phase 6: Behavioral parity testing + persona tuning

**Duration**: 1.5 weeks (~49h, spread over 7.5 working days due to alternating-day protocol)
**Owner**: Senior developer (persona tuning) + backend architect (behavioral comparison)
**Cannot start until**: Phase 5 complete

**Method**: Run opencode as sole agent (not parallel — parallel risks both agents
responding to same trigger). Compare over alternating days: opencode Monday,
Claude Code Tuesday, etc.

#### Behavioral comparison

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P6-T1 | Set up alternating-day comparison protocol | 2h | P5-T17 | Schedule: opencode Mon/Wed/Fri, Claude Code Tue/Thu; logging template for observations | `docs/implementation/parity-comparison-log.md` |
| P6-T2 | Day 1 (opencode): persona adherence check | 2h | P6-T1 | Log: 14 Hard Rules adherence, especially CronCreate retirement, transcript-mirror, governed-memory-deny | log |
| P6-T3 | Day 2 (Claude Code): baseline | 1h | P6-T1 | Log: same 14 Hard Rules adherence as baseline | log |
| P6-T4 | Compare persona adherence (14 Hard Rules) | 3h | P6-T2, P6-T3 | Document: which rules pass/fail on opencode vs Claude Code; identify Claude-Code-specific rules | comparison doc |
| P6-T5 | Compare skill execution quality | 3h | P6-T2, P6-T3 | Document: each skill's output quality on both variants; identify degradation | comparison doc |
| P6-T6 | Compare memory intercept (`ingest_memory` on writes) | 2h | P6-T2, P6-T3 | Document: does `ingest_memory` fire on writes in opencode? Same trigger conditions? | comparison doc |
| P6-T7 | Compare memory recall (context injection before prompts) | 2h | P6-T2, P6-T3 | Document: does recall_lessons inject before model sees prompt? Same quality? | comparison doc |
| P6-T8 | Compare proactive triggers (schedulers reaching agent) | 2h | P6-T2, P6-T3 | Document: do schedulers reach opencode agent? Same latency? | comparison doc |
| P6-T9 | Compare background workers (narrative, reconcile) | 3h | P6-T2, P6-T3 | Document: worker output quality; cadence; cost comparison | comparison doc |
| P6-T10 | Compare alert spine (agent responds to [ALERT] messages) | 2h | P6-T2, P6-T3 | Document: does opencode agent respond to alerts? Same urgency? | comparison doc |
| P6-T11 | Compare reconcile governor (`wrong_close_count` detection) | 2h | P6-T2, P6-T3 | Document: does `wrong_close_count` detect zero-grounding closes on opencode? | comparison doc |

#### Phase 6.5: Persona/skill tuning

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P6.5-T1 | Identify Claude-Code-specific Hard Rules | 3h | P6-T4 | List: CronCreate, transcript-mirror, governed-memory-deny; document why each is Claude-Code-specific | `docs/implementation/hard-rule-variants.md` |
| P6.5-T2 | Rewrite as agent-agnostic intents + variant-specific enforcement | 4h | P6.5-T1 | Each rule has: agent-agnostic intent statement + variant-specific enforcement mechanism; CLAUDE.md updated in shared content | `packages/ll5-run-shared/CLAUDE.md` |
| P6.5-T3 | Tune persona for opencode model's compliance style | 6h | P6.5-T2 | Persona adjusted for opencode model (GPT-5.x or GLM); test with 3+ scenarios; acceptable adherence | shared content + opencode config |
| P6.5-T4 | Re-test after tuning (2 alternating days) | 4h | P6.5-T3 | Re-run P6-T4 through P6-T11 with tuned persona; document improvement | comparison doc |
| P6.5-T5 | Document behavioral differences between models | 3h | P6.5-T4 | Table: Claude vs GPT-5.x vs GLM; per-rule compliance; known quirks | `docs/implementation/model-behavioral-differences.md` |

**Phase 6 total**: 49h (calendar time ~7.5 working days due to alternating-day protocol)

---

### Phase 7: Cutover

**Duration**: 1 day (~4h active + 24h monitoring)
**Owner**: DevOps engineer
**Cannot start until**: Phase 6 complete

| Task | Description | Effort | Dependencies | Acceptance criteria | Files |
|---|---|---|---|---|---|
| P7-T1 | Set `AGENT_VARIANT=opencode` in on-host `.env` | 0.5h | P6.5-T4 | `.env` updated; `OPENCODE_SERVER_URL` derived to `http://agent:4096` | host |
| P7-T2 | Deploy | 1h | P7-T1 | Deploy succeeds; opencode agent container running; Claude Code container stopped | host + CI |
| P7-T3 | Monitor for 24h — watch for silent failures | 4h (spread over 24h) | P7-T2 | Check every 2h: agent responds to messages, schedulers firing, ES writes landing, audit log populating, workers cycling; **watch for 37h silent scheduler breakage pattern + 8-day ES write death pattern** | monitoring checklist |
| P7-T4 | Verify no silent scheduler breakage | 1h | P7-T3 | Schedulers tick (check `recordTickOk` in logs); stuck-message-sweep pass B not flipping | logs |
| P7-T5 | Verify no silent ES write death | 1h | P7-T3 | `ll5_session_history` + `ll5_audit_log` + `ll5_app_log` receiving writes; `warnEsWriteFailure` not firing | ES + logs |
| P7-T6 | Document cutover in `deployment-log.md` | 0.5h | P7-T5 | What was deployed, what was verified, rollback procedure | `docs/implementation/deployment-log.md` |

**Phase 7 total**: 8h (active work + monitoring window)
**Rollback**: Set `AGENT_VARIANT=claude`, deploy. `OPENCODE_SERVER_URL` is derived
from `AGENT_VARIANT` in the deploy script — rollback is truly single-var.

---

## 4. Effort Estimates (Summary)

| Phase | Tasks | Total effort | Calendar time | Notes |
|---|---|---|---|---|
| 0: Rename | 8 | 7.5h | 1 day | No overlap |
| 1: Extract shared | 15 | 18h | 2-3 days | No overlap (after Phase 0) |
| 2: Gateway trigger | 9 | 14h | 1-2 days | Parallel with Phase 0/1 |
| **2.5: Fail-fast gate** | 16 | 26h | 3 days | Blocks Phase 3 |
| 3: opencode repo | 33 | 73h | 2 weeks | Largest phase; internal parallelism |
| 4: Dockerfiles + CI | 10 | 16h | 2-3 days | Needs Phase 1 + Phase 3 |
| **4.5: Compose transition** | 7 | 7.5h | 1 day | Highest operational risk |
| 5: Deploy opencode | 17 | 14h | 1-2 days | Verification-heavy |
| 6: Parity + persona | 16 | 49h | 1.5 weeks | Alternating-day protocol |
| 7: Cutover | 6 | 8h | 1 day (+ 24h monitor) | Single-var rollback |
| **TOTAL** | **137** | **232.5h** | **~30 working days (6 weeks)** | |

**If Phase 2.5 fails**: Effort stops at ~65.5h (Phases 0-2 + 2.5). Phases 0-2 are
retained as net-positive (shared content, gateway trigger abstraction).

---

## 5. Risk Assessment per Phase

### Phase 0: Rename

| Risk class | Description |
|---|---|
| **What can go wrong** | Repo rename breaks CI; PAT scopes insufficient; old image name still referenced somewhere |
| **Silent failure mode** | Agent runs with old image name (stale), new name never gets pulled — system appears to work but is running stale code |
| **Loud failure mode** | Image pull fails, container won't start, CI build fails |
| **Rollback** | Revert CI config to old image name, redeploy. Old repo name redirects on GitHub so local remotes still work. |

### Phase 1: Extract shared content

| Risk class | Description |
|---|---|
| **What can go wrong** | Path references in CLAUDE.md/skills break in Docker context; shared content drifts from variant expectations; render-mcp-config.ts produces invalid config |
| **Silent failure mode** | **Agent runs but with missing/stale persona or skills** — path references resolve to empty/wrong content, agent behaves wrong but doesn't crash. This is the system's dominant failure class. |
| **Loud failure mode** | Docker COPY fails, build breaks; render-mcp-config.ts throws |
| **Rollback** | Restore in-repo copies in ll5-run-claude-code (fallback copy kept until P1-T14); revert CI. |

### Phase 2: Gateway agent-trigger

| Risk class | Description |
|---|---|
| **What can go wrong** | `OPENCODE_SERVER_URL` leaks from env into Claude Code deploys, causing failed HTTP calls; migration fails on production DB; `triggerAgent` swallows errors silently |
| **Silent failure mode** | `triggerAgent` silently no-ops when it should trigger (env var empty when it shouldn't be), OR silently fails when it should trigger (error swallowed, agent never receives messages). The `.catch()` in `insertSystemMessage` marks the row for sweep retry — if sweep also fails silently, messages are lost. |
| **Loud failure mode** | Migration fails, endpoint returns 500, test suite fails |
| **Rollback** | Revert gateway deploy. `OPENCODE_SERVER_URL` empty = Claude Code unaffected. Migration 039 is additive (nullable column), safe to leave in place. |

### Phase 2.5: Fail-fast gate

| Risk class | Description |
|---|---|
| **What can go wrong** | Validation passes but assumptions are subtly wrong (event names changed between versions, granularity differs from documentation, deny semantics look right but have bypass) |
| **Silent failure mode** | **This phase IS the silent-failure prevention mechanism.** The risk is that validation passes on a simplified slice but fails on the full system. E.g., `tool.execute.before` deny works for one tool but not another; `message.updated` gives complete turns for simple cases but fragments for tool-heavy turns. |
| **Loud failure mode** | Plugin fails to load, opencode crashes, MCP connection fails |
| **Rollback** | N/A — this is a validation phase with no production changes. Local scaffold only. |

### Phase 3: Create opencode repo

| Risk class | Description |
|---|---|
| **What can go wrong** | Plugins load but don't fire on right events; dedup logic subtly wrong (double-posts or dropped posts); correlation-ids silently dropped on some MCPs; reconcile worker allowlist bypassable via subagent |
| **Silent failure mode** | **Plugins appear to work but produce wrong behavior**: `stop-mirror` double-posts (dedup logic wrong), `session-history` misses turns (wrong event granularity), `external-authority-gate` allows state-changing tools on some paths (allowlist incomplete), reconcile worker bypassable via subagent (security hole). Each is silent — agent runs, produces output, but the output is wrong or insecure. |
| **Loud failure mode** | Plugin import errors, TypeScript compilation fails, opencode refuses to start |
| **Rollback** | Git revert in ll5-run-opencode. No production impact (local build only until Phase 5). |

### Phase 4: Dockerfiles + CI

| Risk class | Description |
|---|---|
| **What can go wrong** | Image builds with stale content (Docker cache hits wrong layer); variant repo checkout fails (PAT scope); Node build steps crash on variant packages (no `package.json` at root) |
| **Silent failure mode** | **Image builds successfully but contains stale content** — Docker layer cache returns old shared/variant content, image tag is `latest` but content is from last week. Agent runs with stale persona/skills/plugins. |
| **Loud failure mode** | Build fails, image push denied, CI crash |
| **Rollback** | Revert CI changes, rebuild with old Dockerfile. Force cache bust with `--no-cache` if stale content suspected. |

### Phase 4.5: Compose transition

| Risk class | Description |
|---|---|
| **What can go wrong** | Two agent containers running simultaneously (old standalone + new compose); workspace data lost in volume copy; Coolify restarts old container after deletion |
| **Silent failure mode** | **TWO agent containers running** — both respond to PG NOTIFY, duplicate messages sent to user, conversation state corrupted. System appears to work but messages are duplicated. This is the most dangerous silent failure in the entire plan. |
| **Loud failure mode** | Container won't start, workspace data missing, deploy fails |
| **Rollback** | Re-enable old Coolify app (`js8owk0g0cgog800ckc8ww0s`), stop compose agent. The old standalone setup is the fallback. |

### Phase 5: Deploy opencode

| Risk class | Description |
|---|---|
| **What can go wrong** | `OPENCODE_SERVER_URL` wrong (agent unreachable); session not registered (trigger goes nowhere); MCP auth fails; healthcheck passes but agent not processing |
| **Silent failure mode** | **Agent container is up (healthcheck passes) but not triggering** — `OPENCODE_SERVER_URL` set but agent session not registered, or `triggerAgent` calls fail and get swallowed by `.catch()`. Agent appears healthy but never receives messages. Stuck-message-sweep pass B should flip after 30min (loud), but only if pass B is correctly configured for the opencode variant. |
| **Loud failure mode** | Container crash, healthcheck fail, deploy job reports agent not running |
| **Rollback** | `AGENT_VARIANT=claude`, deploy. Single-var rollback — `OPENCODE_SERVER_URL` derived from `AGENT_VARIANT` in deploy script. |

### Phase 6: Parity testing

| Risk class | Description |
|---|---|
| **What can go wrong** | Behavioral degradation not noticed (persona drift, memory not intercepting, skills subtly wrong); alternating-day protocol too slow to catch regressions; persona tuning makes things worse |
| **Silent failure mode** | **Behavioral degradation is inherently silent** — agent produces plausible-but-wrong output. Persona drift (less compliant with Hard Rules), memory intercept not firing (writes not ingested), recall not injecting (agent doesn't see past context). The system's history shows that behavioral degradation can persist for days before notice. |
| **Loud failure mode** | Skills fail completely, workers crash, alerts not responded to |
| **Rollback** | `AGENT_VARIANT=claude`, deploy. Persona tuning changes are in shared content (ll5 repo) — revert commit. |

### Phase 7: Cutover

| Risk class | Description |
|---|---|
| **What can go wrong** | 37h silent scheduler breakage pattern repeats; 8-day ES write death pattern repeats; agent up but not processing; correlation-ids stop landing in audit log |
| **Silent failure mode** | **The system's two most expensive historical failures were silent**: 37h scheduler breakage (schedulers appeared to run but didn't trigger agent) and 8-day ES write death (ES appeared healthy but writes silently failed). The opencode variant introduces new code paths (triggerAgent, HTTP delivery) that could fail silently. Monitoring must check actual agent response, not just container health. |
| **Loud failure mode** | Container down, healthcheck fail, deploy fails |
| **Rollback** | `AGENT_VARIANT=claude`, deploy. `OPENCODE_SERVER_URL` is derived — rollback is one variable. Documented, tested, single-var. |

---

## 6. Parallelization Plan

### Across-phase parallelism

```
Week 1:
  ├─ Track A: Phase 0 (rename) → Phase 1 (extract shared)
  └─ Track B: Phase 2 (gateway trigger)

Week 1-2:
  ├─ Track A: Phase 1 continues → completes
  └─ Track B: Phase 2.5 (fail-fast gate) ← BLOCKS Phase 3

Week 2-4:
  └─ Track B: Phase 3 (opencode repo) — internal parallelism (see below)

Week 4:
  └─ Phase 4 (Dockerfiles + CI) — needs both tracks complete

Week 5:
  ├─ Phase 4.5 (compose transition)
  └─ Phase 5 (deploy opencode)

Week 5-6:
  └─ Phase 6 (parity + persona) — alternating-day protocol

Week 6:
  └─ Phase 7 (cutover + 24h monitor)
```

### Within-phase parallelism

#### Phase 3 (largest phase, most parallelism)

With 3+ developers, Phase 3 can be parallelized into 3 sub-tracks:

| Sub-track | Owner | Tasks | Duration |
|---|---|---|---|
| **Security-critical plugins** | Security engineer | P3-T4 (external-authority-gate), P3-T5 (correlation-id-injector), P3-T20 (reconcile-loop + security tests), P3-T27 (reconcile-worker agent) | ~16h |
| **Stateful plugins** | Senior developer | P3-T3 (memory-intercept), P3-T6 (session-history), P3-T7 (ll5-channel), P3-T10 (stop-mirror), P3-T11 (session-start), P3-T14 (turn-context) | ~20h |
| **P1/P2 plugins + workers + config** | Backend architect | P3-T8, P3-T9, P3-T12, P3-T13, P3-T15–T18, P3-T19, P3-T21–T23, P3-T24–T30 | ~25h |

With 3 parallel sub-tracks, Phase 3 elapsed time: ~25h ≈ 3 days (vs 73h sequential ≈ 9 days).

**Dependency within Phase 3**: All P0 plugins (T3–T7) must complete before T31
(local verification). Config (T24) depends on T5 + T7. Workers (T19–T23) depend
on T2 only. So the critical sub-path within Phase 3 is:

```
T2 → T7 (ll5-channel, 6h) → T24 (opencode.json, 3h) → T31 (verify, 4h) = 13h + T2
```

The security sub-track (T4, T5, T20) has its own critical path:
```
T2 → T4 (external-authority-gate, 4h) → T20 (reconcile-loop, 6h) → T33 (security verify, 2h) = 12h + T2
```

Both run in parallel. Phase 3 elapsed: ~max(13, 12) + overhead = ~3 days with
3 developers, ~5 days with 2 developers, ~9 days with 1 developer.

#### Phase 1 + Phase 2 (parallel)

| Sub-track | Owner | Tasks | Duration |
|---|---|---|---|
| **Phase 1** (content extraction) | Senior developer | P1-T1 through P1-T15 | 18h |
| **Phase 2** (gateway trigger) | Backend architect | P2-T1 through P2-T9 | 14h |

These run fully in parallel. Phase 1 starts after Phase 0 (1 day). Phase 2 starts
immediately.

#### Phase 5 (verification parallelism)

Verification tasks (P5-T7 through P5-T17) can be parallelized across 2 people:
- Person A: server health, session registration, triggers, metadata, MCPs, correlation-ids
- Person B: skills, push_to_user, external-authority-gate, workers, session-history

### Agent specialization assignments

| Role | Phases | Key responsibilities |
|---|---|---|
| **Backend architect** | 2, 3 (workers), 5 (verify), 6 (comparison) | Gateway code, SDK workers, agent-trigger abstraction, behavioral comparison instrumentation |
| **DevOps engineer** | 0, 4, 4.5, 5 (deploy), 7 | Repo management, Docker, CI/CD, compose, deployment, monitoring |
| **Security engineer** | 2.5 (validation), 3 (P0 plugins), 6 (reconcile parity) | external-authority-gate, correlation-id-injector, reconcile worker security, allowlist verification, adversarial review |
| **Senior developer** | 1, 2.5, 3 (stateful plugins), 6.5 (persona tuning) | Shared content extraction, plugin ports, persona/skill tuning, fail-fast validation |

### Minimum team sizing

| Team size | Elapsed time | Notes |
|---|---|---|
| 1 person | ~8-9 weeks | Sequential; no parallelism; risk of context-switching overhead |
| 2 people | ~6-7 weeks | Phase 1+2 parallel; Phase 3 partially parallel; verification parallel |
| 3 people | ~5-6 weeks | Full parallelism as designed above; matches plan's estimate |
| 4+ people | ~5 weeks | Diminishing returns; Phase 3 is the bottleneck and can absorb 3 people max |

---

## Appendix: Silent Failure Detection Checklist

Per the system's history (37h silent scheduler breakage, 8-day silent ES write
death), every phase deployment must include these checks:

| Check | What to look for | Tool |
|---|---|---|
| Agent actually processing | Send test message, verify agent responds | Manual or automated probe |
| Schedulers ticking | `recordTickOk` entries in logs for each scheduler | Log explorer |
| ES writes landing | New docs in `ll5_audit_log`, `ll5_app_log`, `ll5_session_history` | ES query |
| Correlation-ids present | `session_id` + `trace_id` populated in audit log rows | ES/PG query |
| Stuck-message-sweep pass B not flipping | No "stuck pending rows" alert | anomaly-monitor |
| No duplicate agent containers | `docker ps \| grep agent` shows exactly one | host command |
| MCP health probes passing | `channel-health.json` or gateway mcp-health-monitor shows all 6 green | gateway admin |
| Workers cycling | narrative-loop + reconcile-loop logs show recent activity | `docker exec` + log tail |
| Reconcile governor metrics | `wrong_close_count` + `missed_close_count` in ES | ES query |

**Rule**: If any check fails after a phase deployment, do NOT proceed to the next
phase. Investigate the silent failure first. The system's history shows that
silent failures compound — one undetected failure leads to data corruption that
leads to more failures.
