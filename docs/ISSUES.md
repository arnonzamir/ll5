# LL5 Issue Register

The single living list of known defects and degradations. Replaces the old `## Known Issues` bullets in `PROGRESS.md`.

**Working rule:** closing an issue means flipping its `Status` here **and** adding the normal dated `## YYYY-MM-DD —` entry to `PROGRESS.md` in the same commit, with the commit hash in `Closed by`. The pre-commit hook only checks that the three living docs are staged; this file is what keeps state honest.

Statuses: `open` · `in-progress` · `fixed` (shipped, not yet verified live) · `verified` · `wontfix` (with reason).

Origin: the 2026-09-04 agent review (`docs/reviews/2026-09-04/agent-baseline.md`, plan in the session notes). Evidence queries are against the prod ES indices unless noted.

---

## Register

| ID | Class | Sev | Title | Status | Closed by |
|---|---|---|---|---|---|
| ISS-001 | telemetry | high | Eval recorder over-counts deliveries (root cause: span carry-over across quiet turns — see detail) | fixed | agent `b6c896f`, live 16:22Z; verify: no `ping_now` without a delivery tool over 7 days |
| ISS-002 | knowledge | high | `note_observation` near-dead: 18 calls in 15 days, zero Aug 23–31; three-month drift 963 → 11/month | open | |
| ISS-003 | knowledge | high | Narrative consolidation silent 12 days — starved by ISS-002, not a loop fault | open | |
| ISS-004 | behavior | high | `ping_later` books nothing: 57 of 72 claims hollow | open | |
| ISS-005 | telemetry | med | No idempotency on `/telemetry/eval-moment` and `/telemetry/turn-cost` writes | fixed | 2026-09-04 gateway Phase 1 commit |
| ISS-006 | telemetry | med | `ll5_turn_costs` dead since 2026-07-13 | in-progress | writer live 16:23Z (first doc: cold-start turn $5.53 API-equiv, 495K cache-write); `telemetry.turn_costs_stale` check still to add |
| ISS-007 | provenance | high | Live CLI 2.1.197 ≠ Dockerfile pin 2.1.204; running commit unverifiable | verified | 2026-09-04 16:22Z — rolled container: `claude version OK: 2.1.204 == pin 2.1.204` |
| ISS-008 | scaffolding | med | Reconcile subsystem: 682 selector calls, 0 actions, `candidate_count:0` with 5 indistinguishable causes | open | proposal: DECISION-028 |
| ISS-009 | scaffolding | med | Two divergent narrative-freshness policies; two copies of the reconcile selector + gate | open | proposal: DECISION-028 |
| ISS-010 | scaffolding | med | 76.5% of tool calls are housekeeping; 32 gateway schedulers + 2 in-container loops | open | proposal: DECISION-028 |
| ISS-011 | knowledge | med | Journal backlog: 1,229 `context` entries open over 7 days | open | |
| ISS-012 | behavior | low | Learning flat: 3 lessons in 15 days; lessons/user-model history indices take no writes | open | |
| ISS-013 | infra | med | Chronic unfixed: WA bridge stalls, Gmail/Slack mirror listeners, Google OAuth disconnects, TS_AUTHKEY lapsed, agent CI cold since Jul 14 | in-progress | deploy path rebuilt (DECISION-027); the infra stalls remain Phase 6 |
| ISS-014 | telemetry | high | `POST /sessions` exceeds the gateway 1 MB body cap past ~250 messages → 413 swallowed → `ll5_session_history` frozen per session | verified | agent hook `b6c896f` live 16:22Z: `session-save.log` `ok http=201 append msgs=4/4`, new session doc advancing |
| ISS-015 | behavior | high | Post-compaction re-ground reads the frozen session index | verified | session doc advances every Stop from the new container (16:23:55Z); re-ground now reads live data |
| ISS-016 | scaffolding | med | Nothing monitors session age, compaction cadence, or session-save liveness; sessions roll only on container restart | in-progress | `agent.session_save_stale` check shipped 2026-09-04; session-age gauge + daily restart pending |
| ISS-017 | knowledge | med | Governed memory-capture path idle: `ingest_memory` 0 since July, `upsert_lesson` 0 in Sep, `recall_lessons` 7,625 in Aug | in-progress | fail-closed + outbox + autoheal drain live (`b6c896f`); the write-side (lessons in `consolidate`) is Phase 2 |
| ISS-018 | knowledge | high | Agent bypasses ES via `Bash` grep/python over spilled `tool-results/mcp-awareness-*.txt` files | fixed | `spill-read-block.sh` wired (PreToolUse Bash\|Read\|Grep\|Glob), live 16:22Z; verify: zero spill reads over 7 days |
| ISS-019 | knowledge | high | Unbounded MCP read results (`read_journal` ~60 KB, `recall_everything` up to 114 KB, one at 1.7 MB) cause the spill | in-progress | Track B (worktree agent) |
| ISS-020 | behavior | med | Deferred tool schemas: knowledge-write tools absent from the post-compaction reflex set | fixed | core-tools block in `session-start.sh`, live 16:22Z; verify: `ToolSearch` for the core set on each startup/compact |
| ISS-021 | knowledge | med | ~20 MCP `-32602` input-validation failures across 10 tools; `note_observation` 2 of 13 | open | |
| ISS-022 | behavior | med | `record_moment` (a no-op) is 53% of main-session tool calls; with `write_journal` 86% | open | proposal: DECISION-028 |
| ISS-023 | infra | med | CI: a push to main that touches **no** package (docs-only) rebuilds and redeploys all 10 infra services | fixed | 2026-09-04 with DECISION-027 (`else PACKAGES=()` + deploy gated on a non-empty push matrix) |
| ISS-024 | scaffolding | high | Orchestrator had no `agentTokenResolver` (defaulted to `() => null`): the stale-heartbeat **restart path never once worked**, and the DECISION-027 image roll skipped with "no agent token" | verified | `a0e5deb` deployed; 16:22:14Z roll: `reprovisioned:1` — new container on the pinned image |

---

## Detail

### ISS-001 — Eval recorder over-counts deliveries
- **2026-09-04 ROOT CAUSE CORRECTED (from the Aug 21 local eval log):** 166 of the 183 `ping_now` records that day carried **no delivery tool at all** — every one had `message_sent: "Nightly consolidation done…"`, the same push, repeated on Stops at :01/:11/:21 for hours. The `reply`-channel default theory below was wrong. Cause is the recorder's **span carry-over**: `_parse_turn` keeps `span_delivered` across turns and `_span_slice` only cuts at the previous `record_moment`; when the agent skips `record_moment` on quiet turns (it did — "Silent." turns), `evals_seen` stops moving and a delivery tagged after a `record_moment` stays "in span" for every later Stop. **Fixed in the agent repo (Track A, `b6c896f`):** the wrapper passes `floor_ts` = the previous record's new `ts_end`; `_span_slice` drops entries at/before it except the current turn's own; same-trigger re-fires are not recorded twice. Regression test reproduces the live ordering. The `reply` `channel:"system"` exclusion stays as it was (it is correct — `channel || 'web'` posts a visible outbound row).
- **Original (superseded) analysis:** `reply` counts as delivery unless `channel:"system"`
- **Where:** `ll5-run-claude-code:.claude/hooks/lib/eval_record.py` (`DELIVERY_TOOLS`, the `channel == "system"` exclusion); `channel/ll5-channel.mjs:566` makes `channel` optional, default `web`.
- **Evidence:** Aug 21: 183 `ping_now` with `message_sent:true`, all one session (`cb38209f`), 100 of them 09:00–11:00Z — vs 24 outbound rows in `ll5_chat_messages` that day, none 08:00–11:00Z. Partial fix of the 2026-07-01 inversion (`HANDOFF.md`, "Eval recorder semantics changed 2026-07-02").
- **Consequence:** `ping_now`, `decision_mismatch`, and `grounding_calls`-on-ping numbers are contaminated; every `behavior.*` alert reads them.
- **Fix shape:** count a `reply` as delivery only when the channel is explicitly user-facing; make `channel` required in the tool schema.

### ISS-002 — `note_observation` near-dead
- **Where:** `packages/ll5-run-shared/CLAUDE.md:353` — "MUST produce a journal entry **or** a narrative `note_observation`". The `or` made the observation optional; journal is the cheaper half.
- **Evidence (audit_log, `tool_name`):** `note_observation` Jun 963 / Jul 435 / Aug 88 / Sep 11; `write_journal` Jun 3,673 / Jul 6,954 / Aug 9,020. Aug 23–31: zero observations. `docs/design/narratives.md:228` specifies both are written together.
- **Fix shape:** split the `or`; nightly `consolidate` emits a machine-readable tally; one `knowledge.observations_stale` anomaly check.

### ISS-003 — Narrative consolidation silent 12 days
- **Where:** `packages/personal-knowledge/src/repositories/elasticsearch/narrative.repository.ts:420` `selectConsolidationWork` — a narrative is due only when a new observation lands in the 14-day window.
- **Evidence:** `consolidate_narrative`/`upsert_narrative` fired only Aug 21, Aug 22, Sep 4. ~1,000 loop runs logged "Refreshed 0, created 0 … Nothing due" — correct given ISS-002. `last_consolidated_at` by month: Jun 130, Jul 68, Aug 19, Sep 3.
- **Fix shape:** none of its own — resolves with ISS-002. Verify it resumes without touching the loop.

### ISS-004 — `ping_later` books nothing
- **Where:** `channel/ll5-channel.mjs:827` — `record_moment` is pure local instrumentation, no side effect. Only a separate `create_wake`/`create_tickler` makes a deferral real; the recorder merely observes that.
- **Evidence:** `ll5_eval_moments` Aug 21–Sep 4: claimed `ping_later` 72, actual `suppress` 57 (79% hollow). `ping_later` actual = 15 in 15 days; `close_count` sum 4; `pencil_count` sum 14.
- **Fix shape:** `record_moment(decision:"ping_later")` requires a `wake_id`/`tickler_id` (structural); fallback: `behavior.forward_work_stalled` alerts on hollow *rate*.

### ISS-005 — No idempotency on telemetry writes
- **Where:** `packages/gateway/src/server.ts:944` (eval-moment) and `:985` (turn-cost) — bare `esClient.index({ document })`, no `id`, no `op_type`.
- **Consequence:** a retried or double-fired Stop hook double-counts into every rate-shift baseline.
- **Fix shape:** deterministic `_id = ${session_id}:${ts}`, `op_type:'create'`; tests in `__tests__/eval-moment-route.test.ts`.
- **2026-09-04 fixed:** `indexOnce()` in `server.ts` — id `${session_id}:${ts}` + `op_type:'create'`; a 409 returns `{ok:true, duplicate:true}`; no `session_id` → old auto-id append. 5 tests. Caveat: a retry that regenerates `ts` is not deduped (documented, acceptable).

### ISS-006 — `ll5_turn_costs` dead since 2026-07-13
- **Evidence:** index max `timestamp` 2026-07-13T10:18Z; 68 docs total. Writer was the opencode `stop-mirror`; runtime is now the Claude Code variant.
- **Also:** `ll5_turn_costs` and `ll5_reconcile_metrics` have no declared mapping (only `ll5_eval_moments` does, `server.ts:110`).
- **Fix shape:** turn-cost writer for the Claude Code variant; declared mappings; `telemetry.turn_costs_stale` check.
- **2026-09-04 partial:** mappings for `ll5_turn_costs` and `ll5_reconcile_metrics` declared in `GATEWAY_INFRA_INDICES`. Note `ensureIndices` is create-if-missing, so the **existing prod indices keep their dynamic mappings** — this protects fresh deploys/tenants only. The stale check is deliberately **not** added yet: with no writer it would fire immediately and stay red until the agent-repo change ships; it lands together with the writer.

### ISS-007 — Live CLI ≠ pin
- **Evidence:** container `ll5-agent-f08f46b3-…` runs image `ghcr.io/arnonzamir/ll5-run-claude:latest` created 2026-07-15T05:37Z; `/usr/local/lib/node_modules/@anthropic-ai/claude-code/package.json` = **2.1.197**; `ll5-run-claude-code:Dockerfile:70` pins **2.1.204** (bumped 2026-07-08, `ec9f45f6`). Model hard-coded `--model claude-opus-4-7` in `ll5-server:85`.
- **Fix shape:** identify the workflow that builds `ll5-run-claude:latest`; make `docker-entrypoint.sh:186`'s version log an assertion; rotate `TS_AUTHKEY`; one green CI run.
- **2026-09-04 ROOT CAUSE + FIX (DECISION-027):** two images, two pipelines. `ll5-run-claude-code` CI built `ghcr.io/arnonzamir/ll5-agent` (pinned 2.1.204) and deployed it to Coolify app `js8owk0g…` — a zombie (`exited:unhealthy`, 20,026 restarts). The **live** container runs `ll5-run-claude`, built by **ll5** CI from `docker/Dockerfile.ll5-run-claude` with an **unpinned** `npm install -g @anthropic-ai/claude-code` (→ 2.1.197 on Jul 15), only on manual dispatch (last Jul 19) or the weekly schedule — which failed 7/7 since Jul 20 because `build (run-opencode)` 403s on GHCR and fail-fast cancelled `build (run-claude)`. Fix: the ll5 Dockerfile pins the CLI (`ARG CLAUDE_CODE_VERSION`, build-time `claude --version` assertion, `ENV` exported), the agent repo becomes a trigger (`trigger-ll5-rebuild.yml`; its Dockerfile + builder workflow deleted), ll5 builds `run-claude` on that dispatch and on the weekly schedule (opencode dropped from the schedule), the deploy job calls the new orchestrator `POST /runtimes/reprovision-running` so the image actually reaches the per-user containers, the entrypoint asserts the version at boot (critical alert on mismatch), and the zombie Coolify app is deleted. `TS_AUTHKEY` (rotated today) only ever served the deleted path. **Verify:** first dispatch green → `docker exec <agent> claude --version` = 2.1.204 → entrypoint log `claude version OK`. Remaining: delete the `ll5-agent` GHCR package (needs an owner token with `delete:packages`); set `LL5_DISPATCH_PAT` on the agent repo.

### ISS-007 (continued) — first end-to-end dispatch, 2026-09-04 16:01Z
- Agent-repo trigger → ll5 `repository_dispatch` → `build (run-claude)` **green with the tripwire** (`[verify] claude --version -> 2.1.204 (pin 2.1.204)`) → pushed → deploy green → host pulled `latest` (`CLAUDE_CODE_VERSION=2.1.204`, `LANG=en_US.UTF-8`) → deploy called `POST /runtimes/reprovision-running` → orchestrator answered `reprovision skipped, no agent token` → **container not rolled** (still 2.1.197, tmux from Aug 26). The roll step is `|| echo WARNING`, so the job stayed green — correct, but it means "deploy: success" is not "agent rolled"; verify inside the container every time. Cause is ISS-024.

### ISS-024 — Orchestrator could never re-provision on its own
- **Where:** `packages/agent-orchestrator/src/orchestrator.ts:98` `this.agentTokenResolver = deps.agentTokenResolver ?? (async () => null)`; `index.ts` never passed one. Both `reconcile()` (stale-heartbeat restart, `:333`) and `reprovisionRunning()` (`:388`) branch to "no agent token" and skip.
- **Evidence:** orchestrator log 2026-09-04T16:06:01Z `reprovision skipped, no agent token` / `reprovision-running done reprovisioned:0 failed:1`. The restart path has logged `cannot restart, no agent token` since it was written.
- **Fix (2026-09-04):** `SecretsWriter.readAgentToken(userId)` reads `LL5_AGENT_TOKEN` back from the tenant's own `/run/ll5/<uid>.env` (the file the orchestrator writes at provision, 0600), and `index.ts` wires it as the resolver. Caveat: it re-uses the last minted token; if agent tokens ever get an expiry, a re-provision after expiry will launch a container with a dead token — the gateway provision path mints fresh.

### ISS-008 — Reconcile subsystem is a no-op
- **Where:** selector `packages/gateway/src/reconcile.ts:46` (zero-paths at `:57`, `:62`, `:94`, `:103`, `:105`), GTD copy `packages/gtd/src/tools/reconcile.ts:54` (`:79` es-null degrade); governor `scheduler/reconcile-governor.ts:76`.
- **Evidence:** `list_reconcile_work` 682 calls, `reconcile_loop` 0, every `ll5_reconcile_metrics` doc `candidate_count:0`, `reconciliation_coverage:null`, 15 days.
- **Fix shape:** make the zero-paths distinguishable, then fix or retire (DECISION-028).

### ISS-009 — Duplicate policies and selectors
- `scheduler/narrative-consolidation.ts` (default OFF, `promoteThreshold 3 / debounce 6h`) vs `narrative.repository.ts:420` (`1 / 45m`); reconcile selector and gate each exist twice (gateway + gtd).

### ISS-010 — Housekeeping dominates
- **Evidence:** `ll5_audit_log` Aug 21–Sep 4: 27,055 tool calls, 20,700 housekeeping (`list_narratives` 9,350, `write_journal` 4,952, `recall_lessons` 4,009, `list_narrative_work` 1,031, `list_reconcile_work` 682). 32 schedulers in `scheduler/index.ts`.

### ISS-011 — Journal backlog
- **Evidence:** 1,229 `type:context` entries `status:open` created in the last 7 days; `resolve_journal` 467 calls in 15 days; intake ~300/day, nightly consolidation folds 60–85.

### ISS-012 — Learning flat
- **Evidence:** `ll5_agent_lessons` 3 created in 15 days (Aug 19/24/31); `ll5_agent_lessons_history` 0 rows; `ll5_agent_user_model_history` 0 rows despite `write_user_model` ~1/day. Confirm whether history append is archive-only before changing code.

### ISS-013 — Chronic infra
- WA bridge stall on 13 of 15 days (62 journal mentions; Aug 28: 4 criticals, 3 restarts none cleared, self-recovered 1h40m). Gmail mirror listener once ~4.5 days dead; Slack ~29h then ~20h. Google OAuth disconnects Aug 24, 27, Sep 3–4. TS_AUTHKEY rotation wake (Aug 23) **cancelled, not done**. `ll5-run-claude-code` CI last green 2026-07-14.
- **Fix shape:** per source, fix or stop alerting. An alert answered nightly with the same ineffective reflex is worse than none.

### ISS-014 — `POST /sessions` exceeds the 1 MB body cap
- **Where:** `packages/gateway/src/server.ts:363` `express.json({ limit: '1mb' })` (global); `/sessions` handler `:1470`; `ll5-run-claude-code:.claude/hooks/session-save.sh` sends the whole session on every Stop with `curl -sf` (swallows non-2xx); `lib/session_payload.py` caps per-message text at 2,000 chars but not message count.
- **Evidence:** every session freezes at the same point — `2f145954` 174 msgs, `cb38209f` 241, live `6ec9fd1c` 264 (frozen 2026-08-27T06:21Z; transcript now 74,370 lines / 91.8 MB). `ll5_session_history` docs: Jul 1,836, Aug 3.
- **Fix shape:** incremental send (messages after stored `last_message`); log non-2xx to `~/.ll5/`; `agent.session_save_stale` check.
- **2026-09-04 ROOT CAUSE CORRECTED (verified live):** the first wall is in the hook itself, not the gateway. `session-save.sh` passes the payload as one argv string — `curl … -d "$PAYLOAD"` — and Linux caps a single argument at `MAX_ARG_STRLEN` = 131072 bytes. Reproduced in the container: `curl: Argument list too long`, exit 126. 128 KB ≈ 250 messages × ~500 B — exactly the 174/241/264-message freeze points. The gateway's 1 MB cap was the *second* wall behind it. Payload build itself takes 0.9 s for 7,818 messages (no timeout issue). **The agent-side fix is mandatory and blocked on the agent deploy path (ISS-007):** `--data-binary @"$TMPFILE"` (or `-d @-` from stdin) plus `mode:"append"` with a bounded tail, plus logging non-2xx. Until it ships, the hook fails on every Stop; the live doc was unfrozen once by a manual POST (15:25:36Z, 7,818 messages, 2,818 dropped) and will go stale again → `agent.session_save_stale` will fire in 24h, correctly.
- **2026-09-04 (gateway side shipped):** `/sessions` gets a route-scoped `express.json({limit:'10mb'})` (the live 9-day session's full payload measured 3.87 MB / 7,807 messages, so the existing full-overwrite hook resumes saving on its next Stop with no agent change); new `mode:"append"` — caller sends only the tail, gateway keeps stored messages and appends those with `timestamp > stored last_message`, `if_seq_no`/`if_primary_term` guard (409 = retryable), 403 if the stored doc belongs to another tenant. Both modes cap stored messages at 5,000 (oldest dropped, `messages_dropped` counted) and project `transcript_text` from the **newest** 200k chars (it was the oldest 200k — recent turns were never searchable). `agent.session_save_stale` (24h on `indexed_at`, scoped on `user_id.keyword` because the index is dynamic-mapped) added to `anomaly-monitor.ts`. **Remaining (agent repo):** `session-save.sh` sends `mode:"append"` with a bounded tail and logs non-2xx to `~/.ll5/session-save.log`.

### ISS-015 — Re-ground reads the frozen index
- **Where:** `session-start.sh:136` (compact branch) instructs `recent_sessions(days:7)` / `recall_everything({mode:"timeline"})`; both read `ll5_session_history` (`packages/awareness/src/tools/recall-everything.ts:92`).
- **Evidence:** 7 auto-compactions in the live session (Aug 27 18:02 → Sep 4 00:41Z), each re-grounded on the Aug 27 snapshot. Resolves with ISS-014.

### ISS-016 — Sessions unmonitored, roll only on restart
- **Evidence:** live session 9 days; previous 13 days / 136 MB, ended by container restart (`RestartCount=5`). No check in `anomaly-monitor.ts:502` covers session age, compaction, or session-save; zero journal entries mention a compaction.
- **Decision (2026-09-04):** one controlled restart per day, event-triggered on the nightly `consolidate` pass completing (02:45 local fallback), plus a conditional restart if context crosses ~120K. Gated on ISS-014 being verified live.

### ISS-017 — Memory-capture path idle
- **Where:** `memory-intercept.sh` (PreToolUse Write|Edit under `*/memory/*` → `ingest_memory`, deny disk write, fail-open); `memory-recall.sh:16` (`recall_lessons` limit 5 on every UserPromptSubmit).
- **Evidence:** `ingest_memory` Jun 36 / Jul 83 / Aug 0 / Sep 0; `upsert_lesson` Aug 7 / Sep 0; `recall_lessons` Aug 7,625. Memory dirs in the container are empty (the intercept works; nothing feeds it).
- **Decision (2026-09-04):** fail-closed with an outbox (`~/.ll5/memory-outbox.jsonl`) drained by the autoheal loop; disk is transport, never a read source.

### ISS-018 — ES bypass via Bash over spill files
- **Evidence (live transcript):** 14 `Bash` calls in 9 days; 12 are `grep`/`python3` against `/data/home/.claude/projects/-workspace/<session>/tool-results/mcp-awareness-*.txt` (Aug 27 "Ivgi", Sep 2 "Yishay/ישי", nightly `consolidate` parsing Aug 28 ×5, Aug 30 ×2). Zero `Grep`/`Glob`/`Read`/`WebSearch` calls. 8.1 MB of spill files in the live session, 362 MB under `~/.claude/projects`.
- **Consequence:** no audit row, no `grounding_calls` credit, snapshot not live, wiped on redeploy.
- **Fix shape:** ISS-019 removes the cause; a `PreToolUse` Bash hook denies reads under `.claude/projects` / `tool-results/`.

### ISS-019 — Unbounded MCP read results
- **Evidence:** `mcp-awareness-read_journal-*.txt` 50–61 KB per nightly call; `mcp-awareness-recall_everything-*.txt` 73–114 KB; transcript errors "result (1,698,093 characters …) exceeds maximum allowed tokens" and 700,199 / 238,704 / 232,701 chars.
- **Fix shape:** hard result cap (~20 KB) + cursor pagination + `truncated:true, next_cursor` in `recall-everything.ts`, the journal reader, and personal-knowledge `recall`/`list_narratives`.

### ISS-020 — Deferred tool schemas
- **Evidence:** 13 `ToolSearch` calls in 9 days — 10 in the first 16 h, none Aug 27 12:56 → Sep 2 23:10, then only `push_to_user`/`reply`/messaging after compactions.
- **Decision (2026-09-04):** `session-start.sh` pre-loads a core set on `startup`/`compact`; cut tool count in Phase 4.

### ISS-021 — MCP input-validation failures
- **Evidence:** `MCP error -32602` on `read_messages` ×3, `create_tickler` ×3, `write_journal` ×3, `upsert_fact` ×2, `get_person` ×2, `note_observation` ×2, `upsert_lesson`, `log_habit_outcome`, `link_media`, `list_horizons`, `write_user_model`.
- **Fix shape:** diff each tool's Zod schema against what persona/skills instruct; `note_observation` first.

### ISS-022 — `record_moment` turn tax
- **Evidence:** live transcript: `record_moment` 3,211, `write_journal` 2,032, `resolve_journal` 347, `push_to_user` 207, everything else ~350.
- **Fix shape (Phase 4):** infer `decision_claimed` from a structured line in the assistant's final text instead of a tool round-trip.

### ISS-023 — Docs-only pushes redeploy everything
- **Where:** `.github/workflows/build-and-push.yml`, `detect-changes` → `set-matrix`, the push branch. `PACKAGES` starts as the full infra list; the per-package filter only replaces it when `${#FILTERED[@]} -gt 0`. A commit that touches no `packages/<pkg>/` path (docs, workflows, root files) matches nothing, the narrowing is skipped, and the full list goes to the build matrix and then to `deploy`.
- **Evidence:** run `33886995650` for `7dbf725` (docs only: `docs/ISSUES.md`, `docs/reviews/…`, PROGRESS/HANDOFF/FILE_TREE) — `build (…)` ran for all 10 packages and `deploy` ran, all green. Every docs-only commit since this logic landed has done the same: a full-stack restart per doc edit.
- **Fix shape (one line):** `else PACKAGES=(); fi` after the `-gt 0` check, so nothing-matched → empty matrix. Then confirm the `deploy` job's `if:`/`needs:` skips cleanly on an empty matrix for a push (it already does for `repository_dispatch`, whose comment explains the empty-string convention) — a docs-only push should build nothing **and deploy nothing**.
- **2026-09-04 fixed** (bundled with DECISION-027): `else PACKAGES=()` in `set-matrix`, and the deploy job's `if:` gains `(github.event_name != 'push' || needs.detect-changes.outputs.matrix != '')`. Verify: the next docs-only push shows `detect-changes` green, no `build (…)` jobs, `deploy` skipped.

---

## Folded from the old PROGRESS `## Known Issues` (2026-09-04)

| ID | Title | Status |
|---|---|---|
| ISS-K01 | Evolution API `findContacts({where:{}})` times out on 2,913 contacts — single-JID queries work | open (workaround in use) |
| ISS-K02 | Most messaging contacts lack display names — Evolution only provides `pushName`; Android address-book push enriches (needs READ_CONTACTS grant + first sync) | open (mitigated) |
| ISS-K03 | Dashboard MCP client sometimes returns stale responses (needs cache-busting) | open |
