# Agent baseline — 2026-08-21 → 2026-09-04 (15 days)

Frozen control for the remediation plan. Re-run this table after each phase and diff row by row. Issues referenced are in `docs/ISSUES.md`.

**Context:** the agent ran unattended for the whole window. Data plane last commit 2026-08-19; agent repo (`ll5-run-claude-code`) last commit 2026-07-14. Live container `ll5-agent-f08f46b3-0a9c-41ae-9e6a-294c697424e4`, image `ghcr.io/arnonzamir/ll5-run-claude:latest` (built 2026-07-15), Claude Code 2.1.197, `--model claude-opus-4-7`, worker loops `claude-sonnet-4-6`.

## Numbers

| Area | Measurement | Issue |
|---|---|---|
| Chat | 58 user messages, 58 answered. Latency p50 22 s / p90 135 s / max 211 s. 438 assistant outbound (7.5:1 agent:user) | — |
| Rituals | Morning brief 15/15 days, evening close 15/15, nightly consolidation 15/15 | — |
| Eval moments | 2,306 — suppress 1,814 / ping_now 477 / ping_later 15; mismatch 130 (5.6%) | ISS-001 |
| Mismatch shape | claimed `suppress` → actual `ping_now` 67; claimed `ping_later` → actual `suppress` 57 (79% of claimed ping_laters hollow) | ISS-001, 004 |
| Grounding | 237/477 ping_now with `grounding_calls:0` (49.7%) — contaminated by ISS-001 | ISS-001 |
| Follow-through | `close_count` sum 4, `pencil_count` sum 14 | ISS-004 |
| Durable knowledge | `note_observation` 18 (zero Aug 23–31), `upsert_fact` 6, `upsert_person` 10 | ISS-002 |
| Observation drift (monthly) | `note_observation` Jun 963 → Jul 435 → Aug 88 → Sep 11; `write_journal` 3,673 → 6,954 → 9,020 | ISS-002 |
| Narratives | 219 active / 4 dormant / 5 closed; `consolidate_narrative` fired Aug 21, 22, Sep 4 only; `last_consolidated_at` by month Jun 130 / Jul 68 / Aug 19 / Sep 3 | ISS-003 |
| Journal | ~4,950 entries; 1,030 "Narrative freshness" heartbeat; 1,229 `context` still `open` in the last 7 days | ISS-011 |
| Tool calls (audit_log) | 27,055 total; 20,700 housekeeping (76.5%) — list_narratives 9,350 / write_journal 4,952 / recall_lessons 4,009 / list_narrative_work 1,031 / list_reconcile_work 682 | ISS-010 |
| Tool calls (main session transcript, 9 days) | record_moment 3,211 / write_journal 2,032 / resolve_journal 347 / push_to_user 207 / rest ~350; Bash 14, ToolSearch 13, Skill 15, Agent 4; Grep/Glob/Read/WebSearch 0 | ISS-018, 020, 022 |
| Reconcile | `list_reconcile_work` 682, `reconcile_loop` 0; every governor doc `candidate_count:0`, `reconciliation_coverage:null` | ISS-008 |
| Cost telemetry | `ll5_turn_costs` last doc 2026-07-13T10:18Z | ISS-006 |
| Live session | started 2026-08-26T20:23Z; 74,370 lines / 91.8 MB; 7 auto-compactions (Aug 27 18:02, Aug 28 18:25, Aug 30 03:14, Aug 31 14:03, Sep 1 18:12, Sep 2 22:54, Sep 4 00:41 Z) | ISS-016 |
| Session record | `ll5_session_history` for the live session frozen 2026-08-27T06:21Z, `message_count 264`; docs/month Jul 1,836, Aug 3 | ISS-014 |
| Memory routing | container `~/.claude/projects/*/memory` all empty; `ingest_memory` Jun 36 / Jul 83 / Aug 0 / Sep 0; `upsert_lesson` Aug 7 / Sep 0; `recall_lessons` Aug 7,625 | ISS-017 |
| Spill files | 8.1 MB under the live session's `tool-results/`; 362 MB under `~/.claude/projects` | ISS-018, 019 |
| MCP validation errors | ~20 `-32602` across 10 tools; `note_observation` 2 of 13 | ISS-021 |
| Lessons / user model | 3 lessons created; `ll5_agent_lessons_history` 0; `ll5_agent_user_model_history` 0 | ISS-012 |
| GTD | 229 open actions / 62 overdue; inbox 20 captured / 107 processed; 60 habit outcomes (36 done / 15 missed / 5 excused / 3 skipped) | — |
| App log | 1,571,578 docs in the window; 1 `error`, 3 `warn` | (silence is the finding) |
| Infra mentions (journal) | WA bridge 62 on 13/15 days; phone pipeline 25; OAuth 20; listener stall 11 | ISS-013 |

## Against the project KPI table (`docs/implementation/companion-usability-plan.md:152`)

| KPI | Target | Measured | Read |
|---|---|---|---|
| `ping_later` moments/day | ≥1/day | 1.0/day (15 in 15) | nominal — 79% hollow, KPI measures the claim |
| decision_mismatch | trustworthy, then falling | 5.6% | not trustworthy until ISS-001 |
| `grounding_calls` on ping_now | ~0 zero-lookup pings | 49.7% zero | not trustworthy until ISS-001 |
| Weekly review completed | 1/1 every week | deferred correctly Aug 21 → Sun, Aug 28 → Sun; solo fallback declined itself when a deferral existed | working |
| Habit outcomes logged | all active habits incl. `missed` | 60 outcomes, 15 `missed` | working |
| GTD overdue / inbox | falling | 62 overdue (was 76), 20 captured (was 48) | falling |

## Method

Read-only, from a laptop, via the awareness container's `ELASTICSEARCH_URL` (creds never leave the box):

```
ssh root@95.216.23.208 "docker exec awareness-<id> node -e '<fetch $ELASTICSEARCH_URL + path>' <path> <body>"
```

Aggregations: `date_histogram` per day on `ll5_chat_messages.created_at`, `ll5_eval_moments.timestamp`, `ll5_agent_journal.created_at`, `ll5_audit_log.timestamp` (`terms` on `tool_name`), `ll5_knowledge_observations.created_at`; `terms` on `decision`, `decision_claimed`, `topic.keyword`. Reply latency: user→next-assistant gap over non-system `ll5_chat_messages`. Session facts: `docker exec` into the agent container — `tmux capture-pane`, transcript `.jsonl` line/`isCompactSummary` counts, `ls tool-results/`. Tool-use counts: one pass over the live transcript counting `tool_use` block names. GTD: `psql` in the postgres container.
