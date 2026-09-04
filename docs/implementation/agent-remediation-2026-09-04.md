# Agent remediation plan — 2026-09-04 (approved) with live status

This is the repo copy of the plan approved on 2026-09-04 (it lived in a Claude Code plan file outside the repo). **Status is maintained here; the plan text below is frozen as approved.** Companion documents: the issue register `docs/ISSUES.md` (per-issue status and verification), the frozen control `docs/reviews/2026-09-04/agent-baseline.md`, `docs/decisions/DECISION-027-claude-variant-single-image.md`, `docs/decisions/DECISION-028-scaffolding-subtraction.md`, and the re-measure tool `scripts/agent-baseline.sh`.

## Status vs plan (as of 2026-09-04 night)

| Phase / item | Status | Where / what remains |
|---|---|---|
| Phase 0 — register, baseline freeze | done | `docs/ISSUES.md`, `docs/reviews/2026-09-04/` |
| Phase 1 item 0 — ISS-014/015 session record | verified | `/sessions` 10 MB + `mode:append`; hook `--data-binary @file`; `agent.session_save_stale` |
| Phase 1 item 1 — ISS-001 eval recorder | fixed, **7-day window to 2026-09-11** | real cause was span carry-over (`floor_ts`), not the reply default; the optional "make `channel` required in the schema" hardening was not done (not needed for the fix) |
| Phase 1 item 2 — ISS-005 idempotent telemetry | done | `indexOnce`, deterministic ids |
| Phase 1 item 3 — ISS-006 turn costs | done | writer live, mapping declared, `telemetry.turn_costs_stale` |
| Phase 1 item 4 — ISS-007 provenance / deploy path | verified | DECISION-027: one image, pin + boot assertion, dispatch trigger, orchestrator roll (ISS-024) |
| Phase 1b 1 — ISS-019 caps + cursors | verified | `packages/shared/src/mcp/result-cap.ts`, all big readers |
| Phase 1b 2 — ISS-018 spill-read block | fixed | `spill-read-block.sh`; verify zero spill files at re-measure |
| Phase 1b 3 — memory-intercept fail-closed + outbox | done | outbox drained by the autoheal loop |
| Phase 1b 4 — ISS-020 core-tool pre-load | fixed | `session-start.sh` CORE_TOOLS_BLOCK |
| Phase 1b 5 — ISS-021 schema failures | verified | 9 tolerant schemas + tests; persona field names |
| Phase 1b 6 — ISS-016 controlled daily session | verified (manual) | consolidate → `restart-requested` → watcher → fresh session; `agent.daily_restart_missing`; **first real hand-off 2026-09-05 02:00 local** |
| Phase 2 1 — CLAUDE.md journal AND observation | live | persona md5 verified in container |
| Phase 2 2 — consolidate tally | **partial** | `CONSOLIDATE-TALLY …` line lands in the journal (queryable in `ll5_agent_journal`); the "also a whitelisted `/telemetry/eval-moment` field" half was deliberately skipped — the journal line is enough for the 7-day measurement; add the field only if the KPI needs a dashboard |
| Phase 2 3 — `knowledge.observations_stale` | done | 24h |
| Phase 2 4 — ISS-011 resolve budget | **open** | measure first: tonight's tally `resolved=<n>` vs intake; raise the budget in the consolidate skill in the next persona batch if the backlog does not converge |
| Phase 2 5 — ISS-017 governed memory path | **partial** | read side fixed (context pack replaced per-prompt `recall_lessons`); write side — a lesson-promotion step in the consolidate skill — goes in the next persona batch |
| Phase 3 1 — ISS-004 hollow `ping_later` | **open, sequenced** | do together with DECISION-028 #5 (`record_moment` → text sentinel) after the ISS-001 window: the sentinel is where a `ping_later` gets its `wake_id`/`tickler_id` requirement |
| Phase 3 2 — ISS-012 history indices | fixed | was a real bug (1000-field mapping limit), not archive-only; index recreated, awareness deployed 18:31Z; verify a snapshot after tonight's 23:00 `write_user_model` |
| Phase 4 — DECISION-028 batch 1 (#1 #2 #3 #6 #7-clear #8-batch1) | live | reconcile retired both repos, 32 → 26 schedulers, health MCP gone, alerts 6h/24h, rail 5-min poll, narrative loop gated |
| Phase 4 — #5 record_moment sentinel, #8 pass 2, #7 CharacterRefresh/GTDHealth | deferred by decision | #5 after 2026-09-11; #8 pass 2 needs a dashboard-caller audit; #7 needs data |
| Phase 5 — runtime upgrade | **last, by decision** | after the clean 7-day baseline |
| Phase 6 — ISS-013 chronic infra | **open** | only the deploy-path half is done; per-source fix-or-stop-alerting decisions not started |

**What could not be finished on 2026-09-04 and why:** everything left is either (a) waiting on data that does not exist yet (the 7-day window, tonight's first nightly pass), (b) a persona/skill change that costs another agent roll — each roll is a fresh session (~$5.5 cold start) and the first real nightly hand-off is tonight, so those are batched into one "next persona batch": ISS-017 lesson step, #5 sentinel + ISS-004, ISS-011 budget if needed — or (c) sequenced last by decision (Phase 5, Phase 6).

---

# The approved plan (frozen text)


## Context

The live agent ran unattended for the whole review window (Aug 21 – Sep 4). The data plane's last commit is 2026-08-19; the agent repo `ll5-run-claude-code`'s last commit is 2026-07-14. Nothing was shipped to either during the window, so this is a clean read of steady-state behaviour.

The conversational layer is healthy. The memory layer is not, and it failed silently: `ll5_app_log` holds 1.57M docs for the window with **one** error row, and no alert fired. What broke is the chain the whole product rests on — *observe → consolidate → durable knowledge*. `docs/design/narratives.md:39` states the contract plainly: "The agent writes observations constantly and quietly." Over 15 days it wrote **18** observations and **4,952** journal entries, and produced zero durable knowledge for nine consecutive days (Aug 23–31).

Two findings make the current numbers untrustworthy, so they are fixed before anything is judged by them:

1. **The eval recorder over-counts deliveries.** `.claude/hooks/lib/eval_record.py` treats any `reply` as a delivered ping unless the agent explicitly passes `channel:"system"`, and `channel` is optional in the tool schema (`channel/ll5-channel.mjs:566`, defaults to `web`). This is a partial fix of the known 2026-07-01 inversion (`docs/HANDOFF.md:210`). Aug 21 recorded 183 delivered pings against 24 actual outbound messages.
2. **We cannot say which commit the live agent runs.** `Dockerfile:70` pins `CLAUDE_CODE_VERSION=2.1.204` (bumped 2026-07-08), the image is dated 2026-07-15, and the container's global install is **2.1.197** (`/usr/local/lib/node_modules/@anthropic-ai/claude-code`). Same family as the stale-`:latest` trap already in the runbooks.

A third silent write-path death was found while checking memory storage and session hygiene, and it is the one that ties the review together. Memory governance itself is **working as designed**: `PreToolUse → .claude/hooks/memory-intercept.sh` catches any `Write`/`Edit` under a `*/memory/*` path, ships the content to the awareness MCP's `ingest_memory`, and denies the disk write; all three `~/.claude/projects/*/memory` directories in the container are empty. Nothing is going to markdown. But the session record that the agent re-grounds from is frozen: `POST /sessions` (`gateway/src/server.ts:1470`) sends the entire session on every turn, and the gateway's global body cap is `express.json({ limit: '1mb' })` (`server.ts:363`). Past roughly 250 messages the payload crosses 1MB, express returns 413, and `curl -sf` in `session-save.sh` swallows it. Every session freezes at the same place — 174, 241, 264 messages — and the live session's `ll5_session_history` doc has not moved since **2026-08-27T06:21Z** while its transcript has grown to 74,370 lines / 91.8 MB.

Intended outcome: a tracked register that survives this session; the knowledge chain writing again; telemetry that can be trusted; a deliberately smaller amount of self-monitoring scaffolding; and only then a runtime upgrade, measured against a clean baseline.

**User decisions taken (this session):**
- Upgrade last, after telemetry and knowledge are fixed. Subtraction is on the table — name specific removals, each as its own reviewable decision.
- **Session policy:** one controlled restart per day, *event-triggered* on the nightly `consolidate` pass completing (02:45 local fallback), plus a supervisor-triggered restart if context crosses ~120K so auto-compaction becomes the exception. Rationale is grounding fidelity and control, **not** tokens — cadence is roughly token-neutral; after 7 compactions the live context was a seventh-generation summary.
- **Memory-intercept:** fail-closed with a local outbox (`~/.ll5/memory-outbox.jsonl`) drained by the autoheal loop. Disk is transport, never a read source.
- **Deferred tools:** pre-load a core set at every `SessionStart` now; cut the tool count in Phase 4.

A fourth finding, from checking whether the agent bypasses ES: it does, through `Bash`. Zero calls to `Grep`/`Glob`/`Read`/`WebSearch` in 9 days, but 12 of 14 `Bash` calls are `grep`/`python3` against `~/.claude/projects/-workspace/<session>/tool-results/mcp-awareness-*.txt` — the files the harness writes when an MCP result (`read_journal` ~60 KB nightly, `recall_everything` up to 114 KB, one result at 1.7 MB) exceeds the context cap. ES did not fail; the query was unbounded, and the agent searched the overflow file instead of narrowing the query. 8.1 MB of such files in the live session, 362 MB across sessions. Those searches produce no audit row and no `grounding_calls` credit.

---

## Baseline — Aug 21 to Sep 4 (frozen as the control)

| Area | Measurement |
|---|---|
| Chat | 58 user messages, 58 answered. Latency p50 22s / p90 135s / max 211s. 438 assistant outbound (7.5:1 agent:user) |
| Rituals | Morning brief 15/15 days, evening close 15/15, nightly consolidation 15/15 |
| Eval moments | 2306 total — suppress 1814 / ping_now 477 / ping_later 15; mismatch 130 (5.6%) |
| Mismatch shape | claimed `suppress` → actual `ping_now` 67; claimed `ping_later` → actual `suppress` 57 (**79% of claimed ping_laters were hollow**) |
| Grounding | 237/477 ping_now had `grounding_calls:0` (49.7%) — *contaminated by ISS-001* |
| Follow-through | `close_count` sum **4**, `pencil_count` sum **14**, over 15 days |
| Durable knowledge | `note_observation` 18 (zero Aug 23–31), `upsert_fact` 6, `upsert_person` 10 |
| Narratives | 219 active; `consolidate_narrative` fired only Aug 21, Aug 22, Sep 4. Last-consolidated by month: Jun 130, Jul 68, Aug 19, Sep 3 |
| Journal | ~4,950 entries; 1,030 of them the narrative loop's "Narrative freshness" heartbeat; 1,229 `context` entries still `open` in the last 7 days |
| Tool calls | 27,055 total, **20,700 housekeeping (76.5%)** — list_narratives 9,350 / write_journal 4,952 / recall_lessons 4,009 |
| Reconcile | `list_reconcile_work` 682 calls, `reconcile_loop` **0**; every governor doc `candidate_count:0`, `reconciliation_coverage:null` |
| Cost telemetry | `ll5_turn_costs` last doc **2026-07-13** |
| Live session | started 2026-08-26T20:23Z (9 days), 74,370 lines / 91.8 MB, **7 auto-compactions** (~every 24–36h, last Sep 4 00:41). Previous session ran Aug 13 → Aug 26, 136 MB, ended only because the container restarted |
| Session record | `ll5_session_history` doc for the live session frozen at 2026-08-27T06:21Z, `message_count: 264`. 1,836 docs in July, **3 in August** |
| Memory routing | `~/.claude/projects/*/memory` empty in the container — the intercept works. `ingest_memory` **0 calls since July** (36 Jun / 83 Jul); `upsert_lesson` 7 in Aug, 0 in Sep; `recall_lessons` **7,625 in Aug** |
| Observation drift | `note_observation` by month: Jun 963 → Jul 435 → Aug 88 → Sep 11, while `write_journal` went 3,673 → 6,954 → 9,020 |
| GTD | 229 open actions / 62 overdue; inbox 20 captured, 107 processed; 60 habit outcomes logged (36 done / 15 missed / 5 excused) |

---

## Phase 0 — The register (do first, small)

Create **`docs/ISSUES.md`**: the single living list, `ISS-NNN | Class | Severity | Title | Evidence | Status | Closed-by`. Classes: `telemetry`, `knowledge`, `behavior`, `infra`, `scaffolding`, `provenance`.

- Seed with ISS-001…ISS-013 below.
- Fold the three stale bullets under `docs/PROGRESS.md:2008` (`## Known Issues`) into it and replace that section with a pointer. Leave `### Tech Debt` (`:1917`) as-is — different purpose.
- Working rule: closing an issue means flipping its row **and** adding the normal dated `## YYYY-MM-DD —` entry to PROGRESS.md in the same commit. The pre-commit hook (`.git/hooks/pre-commit`) already forces PROGRESS/HANDOFF/FILE_TREE to be staged; it does not check content, so the register is the thing that keeps state honest.
- Freeze the baseline table above into `docs/reviews/2026-09-04/agent-baseline.md` (matches the existing `docs/reviews/2026-05-29/` pattern).

### The issues

| ID | Class | Sev | Title |
|---|---|---|---|
| ISS-001 | telemetry | **high** | `reply` scores as a delivered ping unless `channel:"system"` is passed explicitly — inflates `ping_now`, poisons `behavior.*` alerts (partial fix of the 2026-07-01 inversion) |
| ISS-002 | knowledge | **high** | `note_observation` near-dead: 18 calls in 15 days, zero Aug 23–31 |
| ISS-003 | knowledge | **high** | Narrative consolidation silent 12 days — a correct consequence of ISS-002, not a loop fault |
| ISS-004 | behavior | **high** | `ping_later` books nothing: 57 of 72 claims hollow. `record_moment` is a no-op (`channel/ll5-channel.mjs:827`); only a separate `create_wake`/`create_tickler` makes a deferral real |
| ISS-005 | telemetry | med | No idempotency on `POST /telemetry/eval-moment` / `/telemetry/turn-cost` (`gateway/src/server.ts:944`, `:985`) — bare `index()`, no doc id, so a hook retry double-counts |
| ISS-006 | telemetry | med | `ll5_turn_costs` dead since 2026-07-13 — no spend visibility for 7 weeks |
| ISS-007 | provenance | **high** | Live CLI 2.1.197 ≠ Dockerfile pin 2.1.204; the running commit is unverifiable |
| ISS-008 | scaffolding | med | Reconcile subsystem produced 0 actions in 15 days; `candidate_count:0` has 5 indistinguishable causes, several of them silent failures (`gateway/src/reconcile.ts:57`, `:94`, `gtd/src/tools/reconcile.ts:79`) |
| ISS-009 | scaffolding | med | Two divergent narrative-freshness policies (`narrative.repository.ts:420` vs the OFF-by-default `scheduler/narrative-consolidation.ts`), and two copies of the reconcile selector + gate |
| ISS-010 | scaffolding | med | 76.5% of tool calls are housekeeping; 32 gateway schedulers + 2 in-container loops |
| ISS-011 | knowledge | med | Journal backlog: 1,229 `context` entries still open over 7 days; `resolve_journal` 467 calls in 15 days |
| ISS-012 | behavior | low | Learning flat — 3 new lessons in 15 days, zero `ll5_agent_lessons_history` rows, zero `ll5_agent_user_model_history` versions despite `write_user_model` ~1/day |
| ISS-014 | telemetry | **high** | `POST /sessions` exceeds the gateway's global `express.json({limit:'1mb'})` (`server.ts:363`) once a session passes ~250 messages → 413, swallowed by `curl -sf` in `session-save.sh` → `ll5_session_history` frozen per session (174 / 241 / 264 messages; live session stuck since 2026-08-27T06:21Z) |
| ISS-015 | behavior | **high** | Post-compact re-ground reads the frozen index: `session-start.sh:136` tells the agent to read back 7 days via `recent_sessions` / `recall_everything({mode:"timeline"})`, both of which read `ll5_session_history` (`awareness/src/tools/recall-everything.ts:92`). All 7 compactions in the live session re-grounded on stale data |
| ISS-016 | scaffolding | med | Nothing monitors session age, compaction cadence, or `session-save` liveness — no check in `anomaly-monitor.ts:502` covers any of them, and the agent never journals a compaction. Session rollover happens only on container restart (13-day, then 9-day sessions) |
| ISS-017 | knowledge | med | The governed memory-capture path is idle: `ingest_memory` 0 calls since July, `upsert_lesson` 0 in September, against `recall_lessons` 7,625 in August (hook-driven, `memory-recall.sh:16`, every UserPromptSubmit). Read side ~1000× the write side |
| ISS-018 | knowledge | **high** | Agent bypasses ES via `Bash` grep/python over spilled `tool-results/mcp-awareness-*.txt` files (12 of 14 Bash calls in the live session; Aug 27 "Ivgi", Sep 2 "Yishay", nightly `consolidate` parsing) — no audit row, no grounding credit, container-local, snapshot not live |
| ISS-019 | knowledge | **high** | Unbounded MCP read results cause the spill: `read_journal` ~60 KB per nightly call, `recall_everything` 73–114 KB, one awareness result at 1,698,093 chars. No result cap, no pagination in the awareness/personal-knowledge readers |
| ISS-020 | behavior | med | Tool schemas are deferred (111 tools); after each compaction only `push_to_user`/`reply`/messaging get re-loaded via `ToolSearch`. Knowledge-write tools are absent from the post-compaction reflex set — 6-day gap with no `ToolSearch` at all |
| ISS-021 | knowledge | med | `note_observation` failed MCP input validation 2 of 13 attempts (`-32602`); ~20 such schema failures across `read_messages`, `create_tickler`, `write_journal`, `upsert_fact`, `get_person`, `upsert_lesson`, `log_habit_outcome`, `link_media`, `list_horizons`, `write_user_model` |
| ISS-022 | behavior | med | `record_moment` — a no-op local instrumentation tool — is 3,211 of ~6,100 main-session tool calls (53%); with `write_journal` 86%. Every proactive trigger is a full turn |
| ISS-013 | infra | med | Chronic unfixed: WA bridge stalls on 13 of 15 days (62 journal mentions), Gmail mirror listener once dead ~4.5 days, Slack ~29h then ~20h, Google OAuth disconnects Aug 24/27 + Sep 3–4. TS_AUTHKEY rotation wake for Aug 23 was **cancelled, not done**; `ll5-run-claude-code` CI last green 2026-07-14 |

---

## Phase 1 — Restore ground truth (ISS-001, 005, 006, 007, 014, 015, 016)

Nothing else can be judged until these land.

0. **ISS-014 / ISS-015 first — it is the cheapest high-value fix in the plan.** Make `session-save.sh` send incrementally (only messages after the stored `last_message`) or have the gateway accept a larger body on `/sessions` the way `/webhook/whatsapp` already does (`server.ts:360`, `10mb`). Incremental is the better shape — the payload should not grow without bound in the first place, and `POST /sessions` is already an idempotent full-overwrite keyed on `session_id` (`server.ts:1487`). Then stop swallowing the failure: `curl -sf` must at minimum log a non-2xx to `~/.ll5/`, and an `agent.session_save_stale` staleness check (24h on `ll5_session_history.indexed_at`) goes into `buildChecks()` (`anomaly-monitor.ts:502`) alongside a `agent.session_age` gauge. Until this lands, every post-compact recovery is reading an 8-day-old snapshot of a 9-day-old session, which plausibly contributes to ISS-002's drift.

1. **ISS-001** — in `ll5-run-claude-code:.claude/hooks/lib/eval_record.py`, invert the delivery test: a `reply` counts as delivery only when the channel is explicitly user-facing (`web`/`android`/`cli`), not "anything that isn't the string `system`". Mirror in `ll5-run-opencode/.opencode/plugins/eval-recorder.ts`. Better still, make `channel` required in the channel MCP tool schema (`channel/ll5-channel.mjs:566`) so the default can never be silently wrong.
2. **ISS-005** — give both telemetry writes a deterministic `_id` (`${session_id}:${ts}`) and `op_type:'create'`, or `index` with that id, at `gateway/src/server.ts:944` and `:985`. Extend `__tests__/eval-moment-route.test.ts`.
3. **ISS-006** — restore the turn-cost writer for the Claude Code variant (the opencode `stop-mirror` was its only caller). Add a declared mapping for `ll5_turn_costs` and `ll5_reconcile_metrics` alongside `ll5_eval_moments` at `server.ts:110` — both currently rely on dynamic mapping. Add an `telemetry.turn_costs_stale` check to `buildChecks()` (`anomaly-monitor.ts:502`), same shape as `telemetry.eval_moments_stale` at `:592`.
4. **ISS-007** — determine which workflow builds `ghcr.io/arnonzamir/ll5-run-claude:latest` (the container's actual image; the HANDOFF and the orchestrator also reference `ll5-agent:latest`), confirm the tag's digest, and make the entrypoint's existing version log (`docker-entrypoint.sh:186`) an assertion that fails loudly on a mismatch with the pin. Rotate `TS_AUTHKEY` and get one green CI build on the agent repo — without this, none of Phases 2–5 can ship.

**Then hold 7 days and re-measure the baseline table.** The corrected `ping_now`, mismatch, and grounding numbers are the real control for the upgrade.

## Phase 1b — ES-only by construction (ISS-018, 019, 020, 021) + controlled sessions (ISS-016)

Principle: local disk may be *transport*, never a *read source*. In order of leverage:

1. **Cap and paginate every MCP read (ISS-019).** Hard result cap (~20 KB) + cursor pagination + a `truncated:true, next_cursor` hint in `packages/awareness/src/tools/recall-everything.ts`, the journal reader, and the personal-knowledge `recall`/`list_narratives`. Once nothing overflows there is nothing on disk to grep. Also the largest token win available — each nightly `consolidate` currently pulls 50–60 KB into context.
2. **Close the escape hatch (ISS-018).** New `PreToolUse` hook on `Bash` in `ll5-run-claude-code/.claude/hooks/` (same shape as `repo-write-block.sh`/`cron-block.sh`): deny any command referencing `.claude/projects` or `tool-results/`, reason string pointing at the narrower query (`read_journal(since=…)`, `query_im_messages(conversation_id=…)`). Rules drift; hooks don't.
3. **Memory-intercept fail-closed + outbox.** In `memory-intercept.sh`: on unconfirmed ingest, still deny the disk write and append the payload to `~/.ll5/memory-outbox.jsonl`; `scripts/mcp-autoheal*.sh` drains it on MCP recovery. Hygiene, not urgency — the path has never fired.
4. **Pre-load the core tool set (ISS-020).** `session-start.sh` emits, on `startup` and `compact`, an instruction to `ToolSearch` a fixed list: `note_observation`, `upsert_fact`, `upsert_person`, `recall`, `write_journal`, `record_moment`, `push_to_user`, `create_wake`. Shim until Phase 4 cuts the tool count.
5. **Schema failures (ISS-021).** Diff the 10 failing tools' Zod schemas against what the persona/skills tell the agent to send; fix whichever side is wrong. `note_observation` first.
6. **Controlled daily session (ISS-016).** Sequence: 02:00 `[Nightly consolidation]` → `consolidate` pass → its `consolidation-pass-*` journal entry lands → session-save (Phase 1 item 0, incremental) → `ll5-server` relaunches **without** `--continue` → `SessionStart(startup)` re-grounds from ES → agent writes one `context` journal entry "session restarted — re-ground complete" → `agent.session_age` + `agent.reground_missing` checks in `buildChecks()` confirm both. Trigger is the journal entry, **02:45 fallback** if it never lands (a fixed clock would cut a slow pass — reviewer nights already run 6+ min). Second, conditional restart if context crosses ~120K, so auto-compaction becomes the exception. **Gate:** ships only after Phase 1 item 0 proves the re-ground reads live data — in the wrong order this is a daily amnesia event. In-flight state must already live in ES (`ll5_scheduled_wakes`, journal, tray); known casualties `posted-this-turn.jsonl` and loaded tool schemas are cheap to rebuild.

## Phase 2 — Repair the knowledge chain (ISS-002, 003, 011, 017)

This is the core-promise phase. It is a three-month drift, not an outage — `note_observation` went 963 (Jun) → 435 (Jul) → 88 (Aug) → 11 (Sep) while `write_journal` climbed 3,673 → 9,020. Root cause is a prompt design flaw:

- `packages/ll5-run-shared/CLAUDE.md:353` reads "Every channel event MUST produce a journal entry **or** a narrative `note_observation`." The `or` makes the observation optional, journal is the cheaper half, and the counts show which half won (4,952 vs 18).
- `list_narrative_work` is evidence-driven (`narrative.repository.ts:478-498`: a narrative is due only when a new observation lands in the 14-day window). With no observations, "Nothing due" is *correct* — the loop is healthy and starving.
- The `consolidate` skill promotes only claims seen **≥2 times** (`skills/consolidate/SKILL.md`, Step 2). With observations near zero and each day compacted into one summary, ≥2× rarely triggers. That is why nine days produced no promotions at all.

Changes:

1. Split the `or` in `CLAUDE.md:353`: name the classes of event where an observation is **required alongside** the journal entry (person / group / place / topic named — the litmus test the file already states at `:353` but leaves optional).
2. Make the `consolidate` skill emit a machine-readable tally (`OBSERVED: n, PROMOTED: n, FACTS: n, PEOPLE: n`) the way `prompts/narrative-loop.md` already emits `CONSOLIDATED: N refreshed, M created, K skipped`. Ship that number to `/telemetry/eval-moment` as a new whitelisted integer field (`server.ts:932` whitelist + mapping at `:110`).
3. Add one anomaly check — `knowledge.observations_stale`, staleness on `ll5_knowledge_observations` (24h). One check, on an existing monitor, not a new subsystem.
4. ISS-011: raise the consolidation pass's resolve budget so intake (~300/day) and resolution converge; measure with the same tally rather than adding tooling.
5. ISS-017: decide what the governed memory path is *for*. `memory-intercept.sh` only fires when the agent attempts a markdown memory write, and it has not attempted one since July — so `ingest_memory` is a capture route with nothing feeding it, while `memory-recall.sh` queries `recall_lessons` on every single user prompt. Either make lesson-writing a real step in the `consolidate` skill (paired with the ≥2× promotion rule already there) or retire the interception hook and the per-prompt recall as part of Phase 4. Reading a store nobody writes to is the expensive half of a broken loop.

## Phase 3 — Behaviour integrity (ISS-004, 012)

1. **ISS-004** — make deferral structural instead of promissory. Preferred: `record_moment` with `decision:"ping_later"` requires a `wake_id`/`tickler_id` argument, so a hollow deferral is impossible to express rather than merely flagged after the fact (`channel/ll5-channel.mjs:827`). Fallback: keep it advisory and have the `behavior.forward_work_stalled` check (`anomaly-monitor.ts:606`) alert on the *hollow rate*, not just staleness.
2. **ISS-012** — the lesson/user-model history indices take no writes despite ~daily `write_user_model`. Confirm whether history append is intentionally archive-only; if it is, the KPI reading it is wrong and should be retired rather than the code changed.

## Phase 4 — Subtraction (ISS-008, 009, 010)

One `docs/decisions/DECISION-028-scaffolding-subtraction.md`, with each removal as a separate reviewable item. Named candidates:

- **Reconcile subsystem** — 682 selector calls, 0 actions, 15 days. Either fix the selector (start by making its five zero-paths distinguishable: `reconcile.ts:57`, `:94`, `:103`, `:105`, `gtd/src/tools/reconcile.ts:79`) or retire it with its three governor gauge checks. Do not leave a no-op subsystem alive and alerting.
- **`NarrativeConsolidationScheduler`** (`scheduler/index.ts:213`) — default OFF, superseded by the in-container loop, and carries a second divergent freshness policy (`promoteThreshold 3 / debounce 6h` vs the repo's `1 / 45m`). Delete it and the duplicate policy.
- **Duplicate reconcile selector + gate** — `gateway/src/reconcile.ts:46` vs `gtd/src/tools/reconcile.ts:54`; `reconcile-gate.ts:37` vs `gtd/.../reconcile.ts:152`. If the subsystem survives, collapse to one.
- **`recall_lessons` 4,009 calls / 15 days** (7,625 in August) against 75 lessons and 3 new ones — it *is* fired per prompt by `memory-recall.sh:16`. Gate it on prompt class, or cache, or drop it in favour of the `SessionStart` re-ground that already loads lessons.
- **`record_moment` as a tool call (ISS-022)** — 3,211 turns' worth of a no-op. The Stop-hook recorder already parses the transcript; it could infer `decision_claimed` from a structured line in the assistant's final text (or a lightweight `<moment>` tag) instead of a full tool round-trip. Halves the main session's tool-call count.
- **Tool count** — 111 tools is why schemas are deferred (ISS-020). Target: retire or merge until the core set no longer needs a pre-load shim.

Scope discipline: this phase deletes and merges. It adds nothing.

## Phase 5 — Runtime upgrade (ISS-007 continued)

Only after Phases 1–3 are live and a clean 7-day baseline exists.

1. Bump `Dockerfile:70` `CLAUDE_CODE_VERSION` to current, and change the hard-coded `--model claude-opus-4-7` in `ll5-run-claude-code:ll5-server:85` (`COMMON_FLAGS`, used by both the cold launch at `:110` and the `--continue` relaunch at `:126`) to `claude-opus-5`. Decide separately on the worker loops, which pin `claude-sonnet-4-6` (`scripts/narrative-loop.sh`, `scripts/reconcile-loop.sh`).
2. Rebuild, force-pull, provision. **Verify inside the container**, not from the host — `docker exec … claude --version` plus the entrypoint assertion from Phase 1. This is the standing lesson from the stale-`:latest` incident.
3. Run 7 days, diff every row of the baseline table. Expected movement if the upgrade is doing work: mismatch rate down, hollow `ping_later` down, `close_count`/`pencil_count` up, housekeeping share down.
4. Newer harness features (background tasks, better compaction, plan mode, subagents) are candidates to replace bespoke scaffolding — but that is a *follow-on* decision informed by the diff, not part of this phase.

## Phase 6 — Chronic infra (ISS-013)

Per source, decide *fix or stop alerting* — the agent spent ~300 journal entries nursing these and fixed none:

- WA bridge stall (13/15 days) — the restart reflex demonstrably does not clear it; on Aug 28 three restarts failed and it recovered on its own after 1h40m.
- Gmail / Slack mirror listeners — independent stalls, currently resolved by nudging the user to open the app.
- Google OAuth disconnects — recurring, one-tap fix each time.

An alert that fires nightly and is answered with the same ineffective reflex is worse than no alert; it trains the agent to spend its attention there.

---

## Review — against the project's own goals

**Vision — "knows you deeply… a living model of who you are."** This is the one that is failing, and it is the whole product. The system currently behaves as an excellent short-horizon concierge: it remembers today perfectly (journal + nightly consolidation, 15/15) and accumulates almost nothing. `docs/design/narratives.md:228` specifies that a journal entry and a narrative observation are written *together*; the ratio is 4,952:18. Phase 2 is therefore ranked above everything except the telemetry that proves it.

**Vision — "proactive, not pushy."** Honest reading: unknown, because ISS-001 makes `ping_now` unreliable. What is solid: escalation windows open, expire, and revert routing with written reasoning, and rituals never spammed. What is real regardless of the recorder: `ping_later` 15 moments, `close_count` 4, `pencil_count` 14 over 15 days. The forward-looking half of the coach role is barely running. Against the project's own KPI table (`docs/implementation/companion-usability-plan.md:152`), `ping_later ≥1/day` is nominally met at 1.0/day, but 79% of claims were hollow, so the KPI is measuring the claim rather than the behaviour — the KPI itself needs the Phase 1 fix.

**Purpose — "Simplicity Over Cleverness… no background processing pipelines… does this need to exist, or can Claude handle it?"** This is where the system has drifted furthest. 32 gateway schedulers, 15 declarative anomaly checks, 2 in-container agent loops, an eval spine, a reconcile governor, and a tool-failure backstop — and 76.5% of the agent's tool budget goes to running them. Phase 4 exists because of this principle, and I would judge the plan a failure if it ended with more moving parts than it started with. The honest tension: most of that scaffolding was built in response to a real silent outage, and this review found another one. The answer is not "no monitoring" but *fewer, load-bearing* checks — which is why Phase 2 adds exactly one and Phase 4 removes several.

**Vision — "always aware of your context."** The compaction machinery is genuinely well designed — `PreCompact` backs the transcript up before context is lost, and `SessionStart(source=compact)` reloads open journal, active narratives, user model and lessons, then explicitly warns the agent not to reconstruct from summaries alone (`session-start.sh:136`). The design is right and the *source it points at is stale*. That is the sharpest single instance of this review's pattern: the recovery path was built, tested, and left unmonitored, so when its input froze on 2026-08-27 nothing noticed for eight days. It also gives ISS-002 a plausible mechanism beyond the prompt `or`: an agent that re-grounds seven times on a stale snapshot has weaker grounds to notice that anything is worth promoting.

**Purpose — "Build Once, Deploy Anywhere."** Violated in practice today: the deployed binary does not match the pin, the agent repo's CI has not been green since Jul 14, and the Tailscale key needed for its deploy lapsed on Aug 23 with the reminder cancelled. That is why the deploy path is a Phase 1 prerequisite rather than a chore — right now a fix cannot be shipped even if written.

**Purpose — separation of concerns / storage abstraction / multi-tenancy.** Unaffected by this plan; the duplicate reconcile selector in Phase 4 is a mild separation violation being cleaned up rather than created.

### What I would cut if this is too much

Phases 1 and 2 are the plan. Phase 3's ISS-004 is cheap and high-value. Phases 4–6 are genuinely deferrable — with one exception: **Phase 1's item 4 (deploy path) is not optional**, because nothing else can reach production without it.

### Risks

- `docs/ISSUES.md` becomes another unread doc. Mitigated by making it the *only* Known Issues list and tying closure to the commit that fixes it.
- Fixing ISS-001 will make the proactivity numbers look *worse* overnight (fewer real pings than currently recorded). That is the correction working, not a regression, and it must be stated in PROGRESS.md when it lands so a future reader does not misread the step change.
- Phase 2 changes the persona prompt. Prompt edits only take effect on an agent image rebuild and re-provision — so it is gated on Phase 1's deploy fix, and it will move several metrics at once.
- Local working tree is dirty with unrelated test scaffolding (`packages/ll5-auth`, `packages/system`, `packages/findhub-poller`). Leave it alone or commit it separately; do not fold it into this work.

---

## Verification

- **Phase 0:** `docs/ISSUES.md` exists, PROGRESS `## Known Issues` points at it, baseline frozen under `docs/reviews/2026-09-04/`.
- **Phase 1 (session):** `ll5_session_history.indexed_at` for the live session advances every turn and `message_count` tracks the real transcript; a deliberate oversized payload returns a logged non-2xx instead of vanishing; `agent.session_save_stale` fires when the writer is stopped.
- **Phase 1b (ES-only):** no new files appear under `<session>/tool-results/mcp-*` for 7 days; a deliberately oversized `read_journal` returns `truncated:true` + cursor instead of spilling; a `Bash grep .../tool-results/` attempt is denied by the hook with the redirect reason; `ToolSearch` for the core set appears in the transcript on every `startup`/`compact`; `note_observation` validation failures drop to zero.
- **Phase 1b (sessions):** one new session id per day in `ll5_session_history`, each with a "re-ground complete" `context` journal entry within 5 minutes of start; zero `isCompactSummary` markers in a week's transcripts; `agent.session_age` never exceeds ~26h.
- **Phase 1:** unit tests in `gateway/src/__tests__/eval-moment-route.test.ts` cover the id/dedupe and the new field; a replay of an Aug-21-shaped day scores far fewer `ping_now`; `ll5_turn_costs` takes new docs within an hour; `docker exec <agent> claude --version` equals the Dockerfile pin; one green CI run on `ll5-run-claude-code`.
- **Phase 2:** `ll5_knowledge_observations` shows a non-zero daily count for 7 consecutive days; `consolidate_narrative` fires again without anyone touching the loop; the nightly tally appears in the journal and in ES.
- **Phase 3:** claimed-`ping_later`-with-no-booking becomes unrepresentable (or the hollow rate is alerted); hollow rate trends to zero.
- **Phase 4:** scheduler count and housekeeping share both drop; no alert key disappears without a line in DECISION-028 saying why.
- **Phase 5:** the full baseline table re-run at +7 days, diffed row by row in `docs/reviews/`.
- Standing rule from the runbooks: after each deploy, monitor CI and Coolify until the deploy lands and the service is verified working — do not declare done on a push.

## Files this will touch

- New: `docs/ISSUES.md`, `docs/reviews/2026-09-04/agent-baseline.md`, `docs/decisions/DECISION-028-scaffolding-subtraction.md`
- `packages/gateway/src/server.ts` (telemetry ids, mappings, whitelist), `packages/gateway/src/scheduler/anomaly-monitor.ts` (two checks added, several removed), `packages/gateway/src/scheduler/index.ts` (scheduler removals)
- `packages/ll5-run-shared/CLAUDE.md`, `packages/ll5-run-shared/skills/consolidate/SKILL.md`
- `ll5-run-claude-code`: `.claude/hooks/lib/eval_record.py`, `.claude/hooks/session-save.sh` + `lib/session_payload.py`, `.claude/hooks/memory-intercept.sh` (outbox), `.claude/hooks/session-start.sh` (core-set pre-load, re-ground journal entry), new `.claude/hooks/spill-read-block.sh` + its `settings.json` wiring, `scripts/mcp-autoheal*.sh` (outbox drain), `channel/ll5-channel.mjs`, `ll5-server` (daily relaunch without `--continue`, context-size trigger), `Dockerfile`, `docker-entrypoint.sh` (+ opencode mirrors where the variant must stay at parity)
- `packages/awareness/src/tools/recall-everything.ts`, the awareness journal reader, `packages/personal-knowledge/src/tools/narratives.ts` (`recall`, `list_narratives`) — result caps + pagination
- `packages/gateway/src/scheduler/journal-consolidation.ts` or a small new `session-restart` trigger reading the `consolidation-pass-*` journal entry (whichever is smaller — decide at implementation)
- `packages/gtd/src/tools/reconcile.ts` / `packages/gateway/src/reconcile.ts` (Phase 4 only)
- Per the repo rule, every commit also updates `docs/PROGRESS.md`, `docs/HANDOFF.md`, `docs/FILE_TREE.md`
