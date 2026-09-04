# DECISION-028 — Scaffolding subtraction: fewer, load-bearing loops, checks and tools

**Date:** 2026-09-04
**Status:** proposed
**Related:** ISS-008, ISS-009, ISS-010, ISS-017, ISS-020, ISS-022 (`docs/ISSUES.md`); DECISION-015 (narrative loop), DECISION-025 (active context / reconcile), DECISION-027 (single agent image — the deploy path every agent-side change here rides on); baseline `docs/reviews/2026-09-04/agent-baseline.md`.

`docs/purpose.md`: *"No custom event systems, no internal message buses, no background processing pipelines. If Claude can do it in conversation, don't build infrastructure for it. The question for every component: does this need to exist, or can Claude handle it?"* This proposal asks that question of every loop, scheduler, check and tool the baseline measured, with evidence from the same 15-day window (2026-08-21 → 2026-09-04, prod ES + a read-only look at Postgres). It changes no code. Nothing here is a judgment on why the scaffolding was built — most of it was a correct response to a real silent outage — the bar is *fewer, load-bearing* checks, not none.

## Summary

| # | Candidate | Cost in the window | What it produced | Recommendation | Risk |
|---|---|---|---|---|---|
| 1 | Reconcile subsystem (gateway selector+gate+governor, GTD tools, in-container loop, 5 anomaly checks) | 686 `list_reconcile_work` calls (46/day, one `claude -p` Sonnet run each); 1,409 governor docs; 1 scheduler; 5 checks; 2 tools; ~1,300 lines + 8 test files | **Zero input, ever.** `gtd_horizons.conversation_id` is NULL on all 493 h0 rows → selector exits at `reconcile.ts:62` every tick; 0 candidates in 5,706 docs since Jul 7; 0 `reconcile_loop` calls; 1 alert (`loop.reconcile_worker`, a false positive) | **Retire** the whole subsystem now; re-propose only after a creation path actually stamps `conversation_id` | Low — nothing reads its output but its own checks |
| 2 | `NarrativeConsolidationScheduler` (gateway, default OFF) | 0 firings; 279 lines + test; a second freshness policy (`promote 3 / debounce 6h` vs the repository's `1 / 45m`) | Nothing since 2026-06-24 | **Retire**; the "fallback if the loop dies" role is already covered by `loop.narrative_consolidation` (90 min) | Low |
| 3 | Duplicate reconcile selector + gate (gateway copy vs GTD copy) | 2 × ~110 + 2 × ~120 lines, 4 test files | — | Collapses with #1; if #1 survives, keep the GTD copy only | — |
| 4 | `recall_lessons` from `memory-recall.sh` on every `UserPromptSubmit` | 4,033 calls (269/day) for **59 user messages**; the hook fires on all 5,615 injected system rows too; query = the first 400 chars of the `<channel …>` envelope; relevance is normalised to the top hit so 5 lessons pass the ≥0.3 gate every time | 5 lessons injected per turn regardless of relevance, from a store of 68 active lessons (7 added in Aug, 0 in Sep); SessionStart already injects 12 | **Gate** (skip non-user-facing prompts, query the inner text, absolute threshold); then evaluate **drop** in favour of the SessionStart load | Low; lessons still reach the agent at SessionStart / on demand |
| 5 | `record_moment` tool round-trip | 3,211 of ~6,100 main-session tool calls in 9 days (53%); one extra model round-trip per proactive turn (2,313 turns / 15 days) | `decision_claimed` on 2,060 of 2,313 moments (253 missing) — the only field the tool contributes that a check reads (`behavior.mismatch_spike`, never fired) | **Merge** into the Stop-hook: a structured trailing line in the assistant's final text, parsed by `eval_record.py`; tool removed | Medium — the line must be stripped by the web/Android mirror; test it |
| 6 | `list_narratives` volume (9,350) | 9,350 calls — **not the narrative loop**: 9,349 carry no `session_id`; it is the web chat's `active-topics-rail.tsx` polling `GET /narratives` every 45 s with `limit:150` while a tab is open (1,900/day on 4 days, ≤3/day on 5 days). The loop's own cost is `list_narrative_work` 1,038 + 1,037 journal notes, **1,028 of them "Refreshed 0, created 0"** | Loop: 11 refreshes + 1 create in 15 days (9 of 1,038 ticks did work) | **Gate** the loop (pre-check work over HTTP before spawning `claude -p`; drop the zero-work note); **fix the UI poll** (longer interval / SSE-driven, smaller limit, and stop writing UI reads to `ll5_audit_log`) | Low |
| 7 | 32 schedulers | 32 per user + 2 in-container loops; 17 anomaly checks (the baseline's 15 predates `agent.session_save_stale` and undercounts); alert spine re-notifies the agent every 20 min while firing | Load-bearing 20; inert in window 6; redundant/overlapping 6 (table in §7). `[ALERT]` = 1,074 of 5,615 system messages, **845 of them `channel.gmail` / `channel.slack` "quiet"** → ~300 journal entries about listener stalls | **Retire 4, merge 2, gate 4, keep 22**; cap alert re-notify; 32 → 27 schedulers, 17 → 12 checks | Low–medium; each row has its own rollback |
| 8 | Tool count | **178 tools** the live session connects to (162 registered across 8 ll5 packages + 16 channel tools) — the "111" in the baseline is the 2026-04-07 audit figure; **118 of 178 had zero calls** in 15 days | 60 tools carried all 27,151 calls; 5 tools carried 76% | **Retire/merge** ~40 (list in §8): admin/setup tools out of the agent surface, dead variants folded, read+write pairs merged; target ≤120 | Low; tools stay reachable from the dashboard/admin surface |

**Corrected reading of ISS-010.** The 20,700 "housekeeping" calls split as: 9,350 UI polling (not agent), 4,988 `write_journal` (1,037 loop notes + ~3,950 live agent, its default-write rule), 4,033 hook-driven `recall_lessons`, 1,038 narrative-loop ticks, 686 reconcile-loop ticks. The agent's own housekeeping is ~11,100 of its ~17,800 calls (62%), and the two loops' tick overhead (2,750 calls) produced 12 outcomes.

---

## 1. The reconcile subsystem

**What it is.** DECISION-025 D3–D6, shipped 2026-07-07: a deterministic selector (`packages/gateway/src/reconcile.ts:46` `listReconcileWork`), a mutation gate (`packages/gateway/src/reconcile-gate.ts:37` `applyReconcile`, `:106` `confirmReconcileClose`), a 15-min governor writing `ll5_reconcile_metrics` (`packages/gateway/src/scheduler/reconcile-governor.ts:76`, started at `scheduler/index.ts:392`), the same selector+gate ported into GTD as the tools `list_reconcile_work` / `reconcile_loop` (`packages/gtd/src/tools/reconcile.ts:54`, `:152`, `:251`), an in-container worker (`ll5-run-claude-code/scripts/reconcile-loop.sh`, 30-min `claude -p` on `claude-sonnet-4-6`, prompt `packages/ll5-run-shared/prompts/reconcile-loop.md`, started at `docker-entrypoint.sh:390`), the tray kind `reconcile_confirm` (`packages/gateway/src/tray.ts:52`, `:410`), the GTD migrations `003_reconciliation_columns.sql` / `005_pending_confirm.sql`, and five of the 17 anomaly checks (`scheduler/anomaly-monitor.ts:687–754`: `loop.reconcile_worker`, `loop.reconcile_governor`, `reconcile.missed_close_elevated`, `reconcile.wrong_close`, `reconcile.low_coverage`).

**What it costs.** 686 `list_reconcile_work` calls (46/day — every 30 min, minus ticks yielded to the narrative worker), each one a fresh `claude -p` session with 3 MCP servers connected; 1,409 governor docs in the window (5,706 since Jul 7), each tick running one Postgres query, one ES aggregation over `ll5_awareness_messages`, and a 1,000-doc `ll5_audit_log` fetch; 1 scheduler; 5 of 17 anomaly checks; 2 of the GTD MCP's 25 tools; ~1,300 lines of source and 8 test files (`gateway/__tests__/reconcile{,-gate,-governor,-atomicity,-confirm}.test.ts`, `gtd/__tests__/reconcile{,-gate,-tools}.test.ts`) plus 3 Python security tests in the agent repo. Token cost of the worker runs is not in ES (the loop's per-tick `$` is only in `~/.ll5/reconcile-loop.log` inside the container, not read for this proposal).

**What it produced.** Nothing. Every one of the 5,706 metrics docs has `candidate_count:0`, `missed_close_count:0`, `wrong_close_count:0`, `reconciliation_coverage:null`. `reconcile_loop` was called 0 times. The one alert it raised (`loop.reconcile_worker`, Aug 24 08:11, resolved 15 min later, `notify_count 93`) was the worker yielding to the narrative loop, not a fault.

**Why — the zero-path, resolved.** ISS-008 lists five indistinguishable zero paths. Postgres settles it: of 493 horizon-0 rows (229 active), **zero have ever had a `conversation_id`**; `reviewed_at` is set on 1 row, `pending_confirm` on 0. The selector returns at `reconcile.ts:62` (`if (loops.length === 0)`) on every tick; the ES path, the awareness-null path and the timestamp comparison have never executed in production. The cause is upstream of the subsystem: DECISION-025 D4's "stamp `conversation_id` at every creation path" became an *optional* tool parameter (`packages/gtd/src/tools/actions.ts:26`, `chat.ts:126`) that the agent has never passed. A second design fact compounds it: `stakes` is `consequential` on 488 of 493 rows (the column's fail-safe default), so even with candidates, 99% of closes would route to a human-confirm card — the autonomous-close path this machinery exists for is empty by construction.

**Blast radius if removed.** Readers of its output: the five anomaly checks (removed with it), `tray.ts` `reconcile_confirm` kind (never instantiated — `tray_items` in the window: 1 answered, 0 of this kind), the Android/web tray renderer for that kind (renders nothing today), the ISS-008 row, DECISION-025 (superseded in part), `docs/HANDOFF.md`'s "do not trust `ll5_reconcile_metrics`" line. No skill reads it. The GTD columns (`conversation_id`, `stakes`, `reviewed_at`, `pending_confirm`) stay — dropping columns is not part of a subtraction.

**Recommendation: retire.** Remove the gateway selector/gate/governor and their tests, the GTD tools and their tests, the worker script, prompt, `.mcp.reconcile.json`, the Python security tests, the entrypoint launch, the five checks and their constants, the `reconcile_confirm` tray kind, and the `ll5_reconcile_metrics` mapping in `GATEWAY_INFRA_INDICES` (leave the index's data). If the missed-close problem (the Jul-6 Moti case) is to be solved, the cheap version per purpose.md is: `create_action`/`capture_inbox` called *from a message context* stamps `conversation_id` server-side from the request context, and the existing `[Message Batch Review]` turn — which already reads the thread — asks the live agent "does this inbound close an open loop linked to this conversation?" with `list_actions(conversation_id)`. No worker, no governor, no gate.

**Rollback.** `git revert` of the removal commit(s); the columns and index are untouched, so the subsystem comes back with its history intact. Re-provision the agent (DECISION-027 path) to restore the loop.

## 2. `NarrativeConsolidationScheduler`

**What it is.** `packages/gateway/src/scheduler/narrative-consolidation.ts` (279 lines), started at `scheduler/index.ts:213–235`, `enabled` default `false` since 2026-06-24 (DECISION-015 moved the work to the in-container loop). Its `selectWork()` (`:145`) is a second copy of the freshness policy with different constants — `promoteThreshold 3`, `debounceHours 6`, `maxNarratives 5`, `maxOrphans 4`, narratives fetch `size:500` — versus the repository's `selectConsolidationWork` (`packages/personal-knowledge/src/repositories/elasticsearch/narrative.repository.ts:420`): `promoteThreshold 1`, `debounceMinutes 45`, `max 25`, `size:1000`, and the loop prompt overrides again to `max 4 / promote_threshold 2` (`prompts/narrative-loop.md:6`). Three policies, one of which never runs.

**Cost.** Nothing at runtime (it returns at `start()`), but it is the ISS-009 drift: a future fix to freshness has to be made twice, and the disabled path nudges the *live* agent to spawn a `narrative-consolidator` subagent — the exact in-agent chore DECISION-015 found the live agent will not reliably do.

**Produced.** 0 `[Narrative Freshness]` system messages in the window (or since Jun 24).

**Blast radius.** `user_settings.scheduler.narrative_*` keys (7) become dead; the `narrative-consolidator` agent definition in the agent repo loses its only caller (keep it — the coach-scan and consolidate skills can still spawn it). The `loop.narrative_consolidation` anomaly check already covers "the loop died" (fires at 90 min; it did fire on Jul 13 when the loop was down for an hour, `notify_count 103`).

**Recommendation: retire.** Delete the scheduler, its test and its `index.ts` block; document the single policy in `narrative.repository.ts` and let the prompt's `max/promote_threshold` be the only overrides.

**Rollback.** `git revert`; re-arm via the settings key as before.

## 3. Duplicate selector + gate

Two byte-for-byte mirrors: `gateway/src/reconcile.ts` ≡ `gtd/src/tools/reconcile.ts:54–130` and `gateway/src/reconcile-gate.ts` ≡ `gtd/src/tools/reconcile.ts:152–240` (the GTD copy adds only the `es == null` degrade at `:78`). The gateway copy exists so the governor can call the selector in-process; the GTD copy exists so the worker can call it through the MCP boundary. Both are retired under #1. If #1 is kept against this proposal, the right shape is one copy in GTD and a governor that calls the `list_reconcile_work` MCP tool over HTTP (the gateway already calls MCP tools this way for `/internal/regrounding`, `server.ts:861`).

## 4. `recall_lessons` on every prompt

**What it is.** `ll5-run-claude-code/.claude/hooks/memory-recall.sh` (wired as `UserPromptSubmit`, `settings.json`), which POSTs `recall_lessons({query: prompt[:400], limit: 5})` to the awareness MCP and injects lessons with `relevance ≥ 0.3` as `additionalContext`. Server side: `packages/awareness/src/tools/lessons.ts:83–105` BM25 fuzzy search over active lessons, relevance = `score / top_score`.

**What it costs.** 4,033 calls in 15 days (269/day; 7,625 in August) against 59 user messages. `UserPromptSubmit` fires for every prompt the harness receives, and the ll5 channel injects every scheduler/system row as a prompt — 5,615 system rows in the window — so the hook is a per-turn tax on proactive turns, not a per-user-question recall. Each call is a 12-s-timeout HTTP round-trip in the hook chain before the model starts, and injects ~5 lines into the context on every turn.

**What it produced.** Sampled 40 recent calls: every one returned 5 lessons, every top hit had relevance 1.0 and all 200 returned lessons cleared the 0.3 gate — because relevance is normalised to the best hit, the gate can only drop lessons when there are more than 5 candidates with a wide score spread. The query for those 40 calls was the `<channel source="ll5-channel" id="…" conversation="…">` envelope boilerplate (400 chars, mostly attributes), so the ranking is effectively random over the 68 active lessons. The store barely moves (created: Jun 40, Jul 28, Aug 7, Sep 0; `upsert_lesson` 2 calls in the window), and `session-start.sh:145` already injects 12 active lessons on `startup` and `compact`. There is no signal in the window that a per-turn injected lesson changed a decision; there is no counter-signal either — this is unmeasured, and the proposal says so.

**Blast radius.** ISS-017's "governed recall replaces native memory" design keeps its write path (`memory-intercept.sh` → `ingest_memory`) and its SessionStart read path; only the per-turn read changes. The `recall_lessons` tool stays (the persona tells the agent to call it on demand; 30 `list_lessons` calls in the window show the agent does reach for lessons itself). Nothing in the anomaly set reads the hook.

**Recommendation: gate now, then drop.** (a) In `memory-recall.sh`, exit 0 when the prompt is a `<channel …>` envelope whose `channel` is not user-facing (`web`/`android`/`cli` — the same `USER_FACING` set `eval_record.py:39` uses), which removes ~95% of calls; (b) for user-facing prompts, query the envelope's inner text, not the envelope; (c) replace the normalised gate with an absolute BM25 floor or drop the gate and cut `limit` to 3. Then measure for two weeks: if the injected lessons are never referenced in the agent's reasoning (transcript grep on lesson claims), drop the hook and raise the SessionStart load from 12 to all active lessons (68 one-liners ≈ 2 KB, once per session/compaction).

**Rollback.** Revert the hook script; the hook wiring is unchanged.

## 5. `record_moment` as a tool round-trip

**What it is.** A no-op tool in the channel MCP (`ll5-run-claude-code/channel/ll5-channel.mjs:761` schema, `:827` handler — "no network, no token, no side effect — just acknowledge so the turn proceeds"), mandated by the frozen Eval rule in `packages/ll5-run-shared/CLAUDE.md:365–367` on every proactive turn, and read back from the transcript by the Stop hook (`.claude/hooks/lib/eval_record.py:53` `EVAL_TOOL`, `:301–312` in `_parse_turn`, `:430–435` `decision_claimed` / `decision_mismatch`). The recorder already parses the whole transcript — trigger, every tool call, delivery, staging, grounding calls, latency, tokens — the tool adds only `category`, `inferred_sentiment`, `decision`, `reason`.

**What it costs.** 3,211 tool calls in the live session's 9 days (53% of its ~6,100). Each one is a full assistant→tool→assistant round-trip: the model emits the call, the harness returns the ack, the model produces its final text. On a session that reached 91.8 MB and compacted 7 times, that extra turn re-reads the whole prompt cache each time. **Token cost is not inferable from prod ES**: `ll5_eval_moments` has no token fields (the mapping carries none; `ship_body()` strips them), and `ll5_turn_costs` has been dead since Jul 13 (ISS-006). Only the container transcript's `usage` blocks could size it; that was out of scope for this read-only pass.

**What it produced.** 2,313 moments in the window; `decision_claimed` present on 2,060 (`suppress` 1,750 / `ping_now` 238 / `ping_later` 72), absent on 253 (11% — turns where the rule was skipped anyway). `decision_mismatch` = 130 (5.6%) feeds `behavior.mismatch_spike`, which never fired. `category` and `inferred_sentiment` feed the offline eval dataset (`tools/eval/`), nothing live. The KPI table's `ping_later/day` reads *claimed* `ping_later` (ISS-004: 79% hollow) — the tool's own field is the one that is lying.

**Blast radius.** `eval_record.py` (`EVAL_TOOL` handling, `_span_slice` uses record_moment as the span boundary — that boundary needs a replacement), `tests/test_eval_rule_frozen.py` + `test_eval_record.py` (assert the tool and the rule), the frozen rule text, the `TELEMETRY_SKIP_SUCCESS` set in the channel, the `agent-baseline.md` row, ISS-022, and `docs/design/`'s eval spec. The eval dataset keeps the same fields.

**Recommendation: merge into the Stop hook.** Replace the tool with a single structured trailing line the persona emits as the last line of its final text on proactive turns, e.g. `⟦moment category=work/meeting-prep sentiment="stressed about AMS" decision=suppress reason="…"⟧`; `eval_record.py` parses it from `turn["texts"]` (it already collects them), the span boundary becomes "the previous turn's moment line", and the frozen-rule test asserts the line format instead of the tool. Two hard requirements: (1) the line must never reach a user — proactive turns deliver via `push_to_user`/`reply`, but the assistant's final text is mirrored to the unified web/Android thread by `stop-mirror.sh` / `decide_mirror.py`, so the mirror must strip the sentinel (test it); (2) reactive turns must not emit it (same rule as today). Cost drops to ~30 output tokens per proactive turn; ISS-022 closes; the eval fields survive.

**Rollback.** Re-add the tool to the channel and revert the rule; the recorder can accept both forms during transition (parse the tool if present, else the line).

## 6. The narrative loop and the `list_narratives` volume

**The premise was wrong, and it matters.** `list_narratives` 9,350 is **not** the narrative loop. The loop's prompt (`prompts/narrative-loop.md`) never calls it — it calls `list_narrative_work`, `consolidate_narrative`, `upsert_narrative`, `write_journal`. The audit rows show: 9,349 of 9,350 have no `session_id`; args are `{"status":"active","sort":"relevance","limit":150}` (dominant), `limit:25` and `limit:12`; daily counts are 767 / 405 / 406 / 235 / **1** / 1268 / 1928 / 1902 / 1900 / 532 / **1 / 1 / 1 / 0 / 3**. The `limit:150` caller is the web chat's Active-topics rail — `packages/dashboard/src/components/chat/active-topics-rail.tsx:37` `POLL_MS = 45_000`, `:71` `fetchNarratives({status:"active", sort, limit:150})` — one call every 45 s per open browser tab (1,920/day = one tab open all day). `limit:25` is the gateway's `GET /narratives?sort=now` for the Android Topics rail (`packages/gateway/src/narratives.ts:29` `NOW_FETCH_LIMIT`), refreshed on screen open. Each response carries full summaries for up to 150 narratives (the sampled result is several KB per narrative).

**The loop's real shape.** `list_narrative_work` 1,038 calls = 71/day = every 20 min, exactly as designed (`narrative-loop.sh:35` `INTERVAL 1200`, `claude-sonnet-4-6`, `--mcp-config .mcp.narrate.json` with 2 servers). The 1,037 `write_journal` notes with topic "Narrative freshness" parse to **1,028 ticks with `Refreshed 0, created 0`** and 9 ticks with work (11 refreshes, 1 create). The prompt says *"If both are empty, write nothing and finish"* (`:12`) and then *"Write ONE journal note for the whole batch"* (`:47–48`) — the worker follows the second instruction, so every empty tick leaves a journal row (these are the 1,030 "Narrative freshness" heartbeats in ISS-011's backlog). The loop is starved, not broken: `note_observation` fell to 18 calls in the window (ISS-002), so there is nothing to consolidate; `consolidate_narrative` and `upsert_narrative` were called 12 times each, all on the days observations existed (Aug 21–22, Sep 4).

**Costs.** Loop: 1,038 `claude -p` Sonnet sessions (each: MCP connect ×2, one selector call, one journal write, JSON output), per-tick `$` visible only in `~/.ll5/narrative-loop.log` (not read here); 1,028 junk journal rows; two anomaly checks (`loop.narrative_cadence_regressed`, `loop.narrative_cost_regressed`) that fired once each on Aug 24 for a 15-min blip. UI poll: 9,350 knowledge-MCP calls and ES queries, 9,350 `ll5_audit_log` rows and 9,350 `ll5_app_log` rows that inflate ISS-010's headline.

**Blast radius.** Loop: `loop.narrative_consolidation` (staleness on `list_narrative_work`) and the two regression checks key on the tool call — a pre-check that still calls the tool keeps them armed. UI: the rail and the Topics screen.

**Recommendation.** (a) **Gate the loop's model spawn:** `narrative-loop.sh` calls `list_narrative_work` over HTTP itself (the same `curl` shape `memory-recall.sh` uses) and only launches `claude -p` when `refresh_count + create_count > 0`; remove the unconditional STEP 3 note (note only when N+M>0). Expected: ~1,030 fewer Sonnet runs and ~1,030 fewer journal rows per 15 days, the three checks unchanged (the tool call still lands in `ll5_app_log`). (b) **Fix the UI poll:** raise `POLL_MS` to 5 min and refresh on the chat SSE event that already exists (`/chat/listen`) or on `visibilitychange`; cut `limit` to what the rail renders; and stop the gateway's read-only `/narratives` proxy from writing UI reads into `ll5_audit_log` (the agent's tool-call ledger) — tag them `source:'ui'` or skip the audit write for proxied reads. (c) Leave the loop's cadence at 20 min: the DECISION-015 lesson (the live agent will not grind silent chores) still holds and the starvation is ISS-002's to fix.

**Rollback.** (a) is a shell change inside the agent image; revert and re-provision. (b) is two constants and one gateway branch.

## 7. Scheduler inventory (32) and the alert spine

Evidence: system-message tags in `ll5_chat_messages` (`role:system`, 5,615 rows in the window, all `delivered`), `system_alerts` rows in Postgres, `ll5_eval_moments` by source, and index freshness. Intervals are the `scheduler/index.ts` / `utils/env.ts` defaults unless `user_settings.scheduler` overrides them (not read).

| Scheduler (`scheduler/*.ts`) | Cadence | Evidence in window | Class | Proposal |
|---|---|---|---|---|
| `GTDHealthScheduler` | 4 h, active hours | `[GTD Health Check]` 89; `get_gtd_health` 36; overdue 76 → 62 | load-bearing, over-frequent | **Gate**: once daily, folded into the morning brief (`daily-review.ts` already runs at 07:00) |
| `WeeklyReviewReminder` | Fri 14:00 + fallback | `[Weekly Review]` 3; KPI "working" | load-bearing | keep |
| `EveningCloseScheduler` | 20:30 | `[Evening Close]` 14 (15/15) | load-bearing | keep |
| `HabitScheduler` | per-habit steps | `[Habit Check]` 201; 60 outcomes logged | load-bearing (medication) | keep |
| `WakeScheduler` | 60 s | `[Agent Instruction]` 42 (shared); wakes fired 18 / cancelled 5 | load-bearing | keep |
| `CoachScanScheduler` | Sun 08:00 | `[Coach Scan]` 2 | load-bearing | keep |
| `MessageBatchReviewScheduler` | 30 min, active hours | `[Message Batch Review]` 525; messaging moments 1,073 (822 suppress) | load-bearing, largest proactive driver | keep; it is also where #1's job belongs |
| `HeartbeatScheduler` | 60 s tick, fires on edges | `[New Day]` 14, `[Transition]` 59, `[Time Check]` **0** (30-min silence nudge never fired) | load-bearing (edges); silence path inert | keep |
| `JournalHealthScheduler` | 60-min silence | `[Agent Nudge]` **0** (agent writes ~330 journal rows/day) | inert | **Retire**; `agent.journaling` (18 h) in the anomaly monitor already covers the real failure |
| `HealthPollingScheduler` | 20 min, active hours | `[Health]` **0**; `ll5_health_*` last synced 2026-05-29 | inert 3 months | **Gate**: start only when `health` reports a connected source |
| `JournalConsolidationScheduler` | 02:00 | `[Journal Consolidation]` 14 (15/15) | load-bearing | keep |
| `NarrativeConsolidationScheduler` | off | 0 | inert | **Retire** (#2) |
| `StuckMessageSweep` | 10 min | no attributable evidence (all 5,617 rows `delivered`; the channel marks directly) | unknown | keep (one cheap UPDATE); flag as unmeasured |
| `TrayItemExpiry` | 10 min | `[Decision]` 1; tray rows in window: 1 answered, 0 expired | rarely needed | **Merge** with `PermissionRequestExpiry` into one 10-min expiry sweep |
| `PermissionRequestExpiry` | 10 min | `[Authority]` 0 | rarely needed | **Merge** (above) |
| `MCPHealthMonitorScheduler` | 2 min | no `mcp.*`/`service.*` alert in window (last `mcp.errors.google` Jun 28) | load-bearing (the "data plane is down" check; ES-cascade history) | keep; consider 5 min |
| `CharacterRefreshScheduler` | 4 h, active hours | `[Character Refresh]` 88; the agent journals about them (`character-refresh-*` topics, 14 rows) | unmeasured; redundant once sessions restart daily (ISS-016 plan) | **Gate**: retire when the daily restart lands; CLAUDE.md is re-read at SessionStart |
| `AgentOutputMonitor` | 15 min | `agent.output` last fired Jul 12–13 (a real outage) | load-bearing | keep |
| `WhatsAppFlowMonitor` | 10 min | `channel.whatsapp` 55 critical + 15 resolved messages, `notify_count 266`; WA bridge in journal on 13/15 days | load-bearing, noisy | keep; re-notify cap (below) |
| `WhatsAppWebhookReconciler` | 5 min | no evidence available (logs only) | unknown | keep (DECISION-024 safety net); flag as unmeasured |
| `MetricsMonitor` | 5 min | `channel.gmail` (24 h) **473** + `channel.slack` (8 h) **372** `[ALERT]` messages = 79% of all alert traffic; `notify_count` 1,052 / 1,021; slack still firing at write time; ~300 journal rows about "listener stalled"; ES health part: silent | over-firing | **Gate**: make the phone-mirror channels baseline-relative (same weekday) or phone-push-only; keep ES cluster health |
| `ToolFailureMonitor` | 15 min | `tool.*` last fired Jul 2 | load-bearing backstop (Rule 14) | keep |
| `AnomalyMonitor` | 15 min, 17 checks | fired: `throughput.inbound_messages` 10× (`notify 103`), `behavior.pencil_reflex_stalled` 21 msgs, `behavior.suppress_spike` 14, `behavior.forward_work_stalled` 6, `loop.narrative_cadence_regressed` 2, `loop.reconcile_worker` 1, `agent.session_save_stale` 1; silent: `loop.narrative_consolidation`, `agent.journaling`, `behavior.mismatch_spike`, `telemetry.eval_moments_stale`, `behavior.ungrounded_pings`, `loop.narrative_cost_regressed`, and the 4 other `reconcile.*`/`loop.reconcile_governor` | load-bearing framework | keep; **17 → 12 checks** (drop the five reconcile checks with #1); the `behavior.*` checks read ISS-001-contaminated data and stay until ISS-001 ships |
| `ReconcileGovernorScheduler` | 15 min | 1,409 all-zero docs | inert | **Retire** (#1) |
| `PhoneLivenessMonitor` | 15 min | `channel.phone` 17 critical + 3 resolved; "phone pipeline" 25 journal mentions | load-bearing | keep |
| `CalendarSyncScheduler` | (Google) | `ll5_awareness_calendar_events.updated_at` max Sep 4 15:44 | load-bearing | keep |
| `CalendarReviewScheduler` | 120 min, 07–22 | `[Calendar Review]` 173; calendar moments 147 — the **only** source of real `ping_later` (8) | load-bearing (forward-sim engine) | keep |
| `DailyReviewScheduler` | 07:00 | `[Morning Briefing]` 15 (15/15) | load-bearing | keep |
| `TicklerAlertScheduler` | 60 min | `[Tickler Alert]` 70 (+ instruction wakes) | load-bearing (habit chains arm through it) | keep |
| `ResponseTimeoutScheduler` | 120 s | `[Response Timeout]` 25 for 59 user messages; reply p90 = 135 s | fires on 42% of user turns while the agent is already answering | **Gate**: 5 min, and only if no tool call has landed since the user message |
| `CompositeTriggerScheduler` | 3 min | `[Situation]` 226 (free-block / unanswered-contact) | firing; value unmeasured | keep; revisit after ISS-001 makes `ping_now` per source trustworthy |
| `ChatSearchIndexer` (cluster) | LISTEN/NOTIFY | `ll5_chat_messages` 77,474 docs, live | load-bearing | keep |

**The alert spine.** `utils/alerting.ts:45` re-notifies the agent every 20 min while an alert is firing. That is why two phone-mirror feeds going quiet over a weekend produced 845 `[ALERT]` turns, each a proactive turn (journal + `record_moment` + `recall_lessons`), and why ISS-013's "chronic infra" reads as agent chatter. Proposal, alongside the row above: agent re-notify = once at first fire, once at 6 h, once at 24 h; the phone push cadence is unchanged; `[ALERT RESOLVED]` stays.

**Net:** 32 → 27 schedulers (retire `ReconcileGovernor`, `NarrativeConsolidation`, `JournalHealth`; merge `TrayItemExpiry`+`PermissionRequestExpiry`; `HealthPolling` gated off for this user), 17 → 12 anomaly checks, 2 → 1 in-container loops.

## 8. Tool count

The live session's `.mcp.json` (agent repo) connects 9 servers: `personal-knowledge` 30, `gtd` 25, `awareness` 44, `ll5-calendar` (google) 18, `ll5-messaging` 21, `health` 12, `vault` 6, `system` 6, `ll5-channel` 16 = **178 tools** (registration scan over `packages/*/src` + `channel/ll5-channel.mjs`). The baseline's "111" is the 2026-04-07 audit line in PROGRESS.md and is stale. ISS-020's deferral is a function of this number.

Calls in the window (`ll5_audit_log` `terms` on `tool_name`, 27,151 rows): 60 distinct tools were called; **118 of 178 had zero calls**. The channel tools are not in the audit index — from `ll5_app_log`: `push_to_user` 396, `reply` 50, `inspect_image` 39, `set_today_card` 31, `add_tray_item` 2, and `record_moment` is skipped by `TELEMETRY_SKIP_SUCCESS`.

Zero-call tools by package (candidates; "retire" = remove from the agent surface, the dashboard/admin can keep an HTTP path; "merge" = fold into a sibling):

- **awareness (26 of 44 unused):** `acknowledge_events`, `delete_location_point`, `delete_media`, `geocode_address`, `get_area_context`, `get_calendar_events` (duplicate of google `list_events`), `get_current_wifi`, `get_distance`, `get_entity_statuses`, `get_media_for`, `get_notable_events` (inside `get_situation`), `get_phone_status_history`, `get_tracked_devices`, `get_user_model_version`, `get_wifi_history`, `ingest_memory` (hook-only — keep, ISS-017), `link_media`, `list_user_model_versions`, `query_visits`, `retire_lesson`, `search_nearby_pois`, `suggest_frequent_places`, `unlink_media`, `upload_media`, `where_is_device`, `where_is_user` (persona now says prefer `get_situation`). Proposal: retire the media quartet and the wifi/device/version/history sextet from the agent surface; merge `get_calendar_events` into google; keep `ingest_memory`, `where_is_user`, `retire_lesson`.
- **gtd (12 of 25 unused):** `create_habit`, `habit_trends`, `list_conversations`, `list_horizons`, `process_inbox_item`, `send_message`, `update_habit`, `update_project`, `upsert_horizon`, plus `list_reconcile_work`/`reconcile_loop` (retired under #1). Proposal: retire the two reconcile tools; merge `create_habit`+`update_habit` into `upsert_habit`; keep the rest (weekly review / horizons are low-frequency by nature — 2 `[Coach Scan]` in the window).
- **google (9 of 18 unused):** `check_availability`, `configure_calendar`, `delete_event`, `disconnect`, `handle_oauth_callback`, `list_emails`, `send_email`, `set_timezone`, `sync_calendar`. Proposal: retire the OAuth/config quintet from the agent surface (dashboard settings own them); keep `delete_event`, `check_availability`, email pair.
- **messaging (all 21 unused by the agent):** the whole server — `read_messages` etc. are reached through `query_im_messages`/`check_messages` on awareness/gtd; sends go through `push_to_user`/`reply`. Proposal: keep `send_whatsapp`, `send_telegram`, `read_messages`, `resolve_contact`, `get_contact_settings`/`set_contact_settings`; retire the 15 account-provisioning/pairing/backfill tools from the agent surface (dashboard-only).
- **health (all 12 unused):** no source connected since May. Proposal: gate the server out of `.mcp.json` until a source is connected (same gate as `HealthPollingScheduler`).
- **vault (all 6 unused), system (all 6 unused):** vault is DECISION-022 with onboarding pending — keep 2 (`login_status`, `browser_login`), hold the rest; `system` (6) is the host-metrics MCP — retire from the agent surface (the anomaly/metrics monitors read the same numbers).
- **personal-knowledge (13 of 30 unused):** `delete_*` ×4, `find_place_by_bssid`, `label_network`/`unlabel_network`/`list_known_networks` (wifi labelling — DECISION-021, dashboard-driven), `list_data_gaps`/`upsert_data_gap`, `list_facts`, `get_place`/`list_places`, `update_profile`. Proposal: retire the network trio and the data-gap pair from the agent surface; keep deletes (rare, needed) and places.
- **channel (16):** `get_message`, `react`, `new_conversation`, `save_image`, `narrate`, `get_user_settings`/`set_user_settings`, `channel_health`, `check_mcp_connectivity` not visible in the window's telemetry (the channel skips successes for several) — no proposal without a transcript count; `record_moment` retired under #5.

A conservative pass (reconcile 2, awareness 10, gtd 1 net, google 5, messaging 15, health 12 gated, system 6, knowledge 5, channel 1) takes 178 → ~120 and keeps every tool the agent actually reached for. Deferral (ISS-020) should be re-measured at that count before deciding whether the SessionStart pre-load is still needed.

---

## What this removes

Code (ll5):
- `packages/gateway/src/reconcile.ts`, `reconcile-gate.ts`, `scheduler/reconcile-governor.ts`; `__tests__/reconcile*.test.ts` (5 files); `scheduler/anomaly-monitor.ts` checks `loop.reconcile_worker`, `loop.reconcile_governor`, `reconcile.missed_close_elevated`, `reconcile.wrong_close`, `reconcile.low_coverage` and constants `MISSED_CLOSE_MAX`, `WRONG_CLOSE_MAX`, `MIN_COVERAGE`, `MIN_CANDIDATES_FOR_COVERAGE`; the `latestGauge` check kind if nothing else uses it; `tray.ts` `reconcile_confirm` kind + `enqueueReconcileConfirm`; `server.ts` `ll5_reconcile_metrics` mapping in `GATEWAY_INFRA_INDICES`; `scheduler/index.ts:387–397`.
- `packages/gtd/src/tools/reconcile.ts` + registration + `__tests__/reconcile{,-gate,-tools}.test.ts`.
- `packages/gateway/src/scheduler/narrative-consolidation.ts` + test + `scheduler/index.ts:203–235`.
- `packages/gateway/src/scheduler/journal-health.ts` + test + `scheduler/index.ts:182–187`.
- `packages/ll5-run-shared/prompts/reconcile-loop.md`.
- `packages/gateway/src/scheduler/permission-request-expiry.ts` folded into `tray-item-expiry.ts` (one sweep, one timer).

Code (agent repo `ll5-run-claude-code`): `scripts/reconcile-loop.sh`, `.mcp.reconcile.json`, `scripts/test_reconcile_*.py` (3), `docker-entrypoint.sh:385–392`; `record_moment` in `channel/ll5-channel.mjs` (schema `:761`, handler `:827`, skip-set `:795`) replaced by the text sentinel; the Eval rule text in `packages/ll5-run-shared/CLAUDE.md:365–367` rewritten for the sentinel.

Schedulers: `ReconcileGovernorScheduler`, `NarrativeConsolidationScheduler`, `JournalHealthScheduler` retired; `TrayItemExpiry` + `PermissionRequestExpiry` merged; `HealthPollingScheduler` gated on a connected source (off for this user).

Alert keys removed (and why): `loop.reconcile_worker`, `loop.reconcile_governor`, `reconcile.missed_close_elevated`, `reconcile.wrong_close`, `reconcile.low_coverage` — the subsystem they observe never had an input and is removed; their `null → no alert` self-arming means nothing observable changes on the day they go. No other alert key is removed.

Tools: `list_reconcile_work`, `reconcile_loop`, `record_moment`, and the §8 list (~55 from the agent's `.mcp.json` surface; none deleted from the dashboard/admin paths without a separate decision).

## What it must not remove

- **Every check that has caught a real outage:** `agent.output` (Jul 12–13), `loop.narrative_consolidation` (Jul 13), `telemetry.eval_moments_stale` (the Jul 14 hook-wiring incident), `channel.whatsapp` (WA bridge, 13 of 15 days), `channel.phone`, `service.google-auth`, `throughput.inbound_messages`, `tool.*` (ToolFailureMonitor, the inspect_image lesson), `agent.session_save_stale` (ISS-014, fired once already), the MCP health probe. These stay at their current thresholds.
- **The alert spine itself** (`system_alerts`, `POST /alerts`, phone push escalation) — only the agent re-notify cadence changes.
- **The in-container narrative loop** (DECISION-015's finding stands; the loop is starved by ISS-002, not broken) and its three checks.
- **The rituals and their schedulers** (morning brief, evening close, journal consolidation, weekly review, coach scan, habit checks, calendar review, message batch review, ticklers, wakes, composite triggers, calendar sync, chat indexer).
- **The GTD reconciliation columns and migrations**, `ll5_reconcile_metrics` data, `ll5_eval_moments` and its fields (`decision_claimed` keeps its meaning under #5).
- **The governed memory write path** (`memory-intercept.sh` → `ingest_memory`, ISS-017's fail-closed outbox) and the `recall_lessons` / `list_lessons` tools; only the per-turn hook read is gated.
- **`get_situation`, `recall_everything`, `where_is_user`, `note_observation`, `upsert_*`** and every tool with a call in the window.

## Implementation order and verification

Each step is one PR, independently revertible; the baseline table is re-run after each (`docs/reviews/2026-09-04/agent-baseline.md`, "Method").

1. **Reconcile retire (#1, #3) + the five checks.** Gateway + GTD in one ll5 PR; agent-repo PR for the loop; DECISION-025 gets a "D3–D6 retired by DECISION-028" note. Verify: `list_reconcile_work` = 0 in `ll5_audit_log` after re-provision; no `ll5_reconcile_metrics` doc newer than the deploy; scheduler count in `/admin/health.schedulers` drops by 1; `buildChecks()` length 12; gateway + gtd suites green.
2. **Narrative-scheduler retire (#2) + journal-health retire + expiry merge (#7).** Verify: scheduler count 27 for this user; `[Agent Nudge]` and `[Narrative Freshness]` absent (they already are); tray/authority expiry still fires (seed one expiring row in staging).
3. **UI poll fix + audit tagging (#6b).** Verify: `list_narratives` rows in `ll5_audit_log` with no `session_id` ≈ 0 (or tagged `source:ui`); rail still refreshes on SSE.
4. **Narrative-loop pre-check (#6a).** Agent repo. Verify: `claude -p` launches per day ≈ ticks with `refresh_count+create_count>0` (read `~/.ll5/narrative-loop.log`); "Narrative freshness" journal rows/day ≈ that number; `loop.narrative_*` checks stay armed (`list_narrative_work` still 71/day in `ll5_app_log`).
5. **`recall_lessons` gate (#4).** Agent repo. Verify: `recall_lessons` calls/day ≤ user-facing prompts/day (~4); SessionStart still injects lessons (transcript shows the `[Operating lessons …]` block after `compact`).
6. **`record_moment` → sentinel (#5).** Agent repo + shared CLAUDE.md; recorder accepts both during the roll. Verify: `record_moment` tool calls = 0 in the transcript; `decision_claimed` present on ≥ 89% of `ll5_eval_moments` (today's rate); zero sentinel lines in `ll5_chat_messages` (`role:assistant`); `behavior.mismatch_spike` still computable.
7. **Alert re-notify cap + MetricsMonitor channel gating + ResponseTimeout / GTDHealth / CharacterRefresh gates (#7).** Verify: `[ALERT]` system rows/day from `channel.gmail`/`channel.slack` ≤ 3 per firing; `[Response Timeout]` rows ≤ 10% of user messages; `[GTD Health Check]` ≤ 1/day.
8. **Tool-surface cut (#8).** Agent repo `.mcp.json` + per-MCP `registerTools` gating by caller role (agent vs dashboard). Verify: tool count in the harness ≤ 120; the 60 tools with calls in the baseline all still callable; ISS-020's `ToolSearch` count re-measured.

Expected baseline deltas after 1–8: tool calls in `ll5_audit_log` per 15 days from 27,151 to ~11,000 (UI reads gone, hook reads gone, loop ticks gated), housekeeping share from 76.5% to ~35% (`write_journal` remains the largest, and that is the persona's default-write rule, a separate question); schedulers 32 → 27; anomaly checks 17 → 12; in-container loops 2 → 1; `[ALERT]` rows/day from ~72 to <10; main-session `record_moment` 3,211 → 0.

## Evidence gaps (stated, not guessed)

- **Token cost** of `record_moment`, the loops' `claude -p` runs and the alert turns: not in prod ES (`ll5_eval_moments` carries no token fields; `ll5_turn_costs` dead since Jul 13). The loop logs inside the container hold per-tick `$`; not read.
- **`StuckMessageSweep`, `WhatsAppWebhookReconciler`, `CompositeTriggerScheduler`, `CharacterRefresh`:** no signal either way in ES/Postgres; kept or gated on design grounds, marked unmeasured.
- **`/admin/health.schedulers`** (per-scheduler tick/failure counters) needs an admin token and was not read; the inventory uses emitted messages and alerts instead.
- **Whether per-turn injected lessons ever changed a decision:** unmeasured; the gate-then-measure order in #4 is the answer.
- **Channel-tool call counts** (`get_message`, `react`, `narrate`, …): the channel skips successful-call telemetry for several, and the transcript was not re-counted here.
- **Cost attribution of the dashboard poll** to a single tab vs several users: the audit rows carry the user id only; 1,920/day matches one tab at 45 s.

## Alternatives considered

- **Fix the reconcile input (stamp `conversation_id`) and keep the subsystem.** Rejected for now: even fed, 99% of its closes route to human-confirm cards by the stakes default, and the Message Batch Review turn already holds the thread the worker would re-read. Re-propose if a stamped creation path exists and missed closes are still observed.
- **Keep the gateway narrative scheduler as a fallback.** Rejected: an alert plus a human is a cheaper fallback than a second policy that nudges the live agent into a chore it does not do.
- **Turn `record_moment` into a cheaper tool (no round-trip).** Not possible in the harness — a tool call is always a round-trip; the only zero-turn channel is the assistant text the Stop hook already reads.
- **Lengthen the narrative loop to 60 min instead of pre-checking.** Rejected: it triples the freshness lag on the rare tick that has work, and saves less than the pre-check (which spends nothing on 99% of ticks).
- **Drop `recall_lessons` outright now.** Deferred: the SessionStart load covers the same store, but the per-turn injection has never been measured; gate first, measure, then drop.
- **Delete unused tools from the MCPs.** Rejected in favour of surface gating: the dashboard/admin paths use several of them (provisioning, OAuth, network labelling); the agent's `.mcp.json` and a per-caller registration filter are enough to shrink what the harness sees.

## Consequences

- Fewer moving parts, each with evidence of use: 27 schedulers, 12 checks, 1 loop, ~120 tools. The ISS-010 headline becomes an honest number.
- The reconcile question is returned to purpose.md's default — the conversation the agent already has with the thread — rather than closed.
- The alert spine gets quieter for the agent without getting quieter for the phone.
- `ll5_reconcile_metrics` and the reconcile columns remain as history; a future proposal can rebuild on them.
- Every agent-side step (4, 5, 6, and the loop changes) depends on the DECISION-027 deploy path and should be sequenced after ISS-001/ISS-014's agent-side fixes, which share the same PR train.
