# Agent baseline — 2026-09-04 → 2026-09-05 (2 days)

Re-measure generated 2026-09-05T00:17Z by `scripts/agent-baseline.sh --since 2026-09-04 --until 2026-09-05` for user `f08f46b3-0a9c-41ae-9e6a-294c697424e4`. Same rows as the frozen control `docs/reviews/2026-09-04/agent-baseline.md`; issues are in `docs/ISSUES.md`.

## Numbers

| Area | Measurement | Issue |
|---|---|---|
| Chat | 14 user messages, 14 answered. Latency p50 26 s / p90 195 s / max 211 s. 32 assistant outbound (2.3:1 agent:user) | — |
| Rituals | Morning brief 2/2 days, evening close 1/2, nightly consolidation 2/2 | — |
| Eval moments | 114 — suppress 93 / ping_now 19 / ping_later 2; mismatch 7 (6.1%) | ISS-001 |
| Mismatch shape | claimed `suppress` → actual `ping_now` 4; claimed `ping_later` → actual `suppress` 2 (66.7% of 3 claimed ping_laters hollow) | ISS-001, 004 |
| Grounding | 11/19 ping_now with `grounding_calls:0` (57.9%) | ISS-001 |
| Follow-through | `close_count` sum 0, `pencil_count` sum 1 | ISS-004 |
| Durable knowledge | `note_observation` 22 (0 zero-days of 2), `upsert_fact` 1, `upsert_person` 0; observations index +18; note_observation/day: 09-04:22 | ISS-002 |
| Narratives | 220 active / 4 dormant / 5 closed; `consolidate_narrative` 9 calls on 1 days (09-04); `last_consolidated_at` in window 7 | ISS-003 |
| Journal | 349 entries; 59 "Narrative freshness" heartbeat; 179 `context` still `open` in the window (179 in the last 7 days) | ISS-011 |
| Session restarts (journal) | `session-restart` entries/day: 09-04:6 (total 6) | ISS-016 |
| CONSOLIDATE-TALLY | 1 lines; consolidated 3, observations 3, prestaged 15, promoted_facts 0, promoted_people 0, resolved 46, reviewer_dropped 0, reviewer_fixed 0, user_model_sections 1 | ISS-002 |
| Tool calls (audit_log) | 1,366 total; 747 housekeeping (54.7%) — write_journal 349 / recall_lessons 184 / list_narrative_work 77 / resolve_journal 46 / list_reconcile_work 37 / note_observation 22 / get_gtd_health 20 / read_journal 16 / read_user_model 16 / recall_everything 16 | ISS-010 |
| Cost telemetry | `ll5_turn_costs` 55 docs, sum cost_usd $85.91, median cached_tokens 889,395, max 3,465,428; last doc 2026-09-05T00:02:16.258Z | ISS-006 |
| Session record | `ll5_session_history` 8 distinct session_ids indexed in the window; newest indexed_at 2026-09-05T00:02:18.620Z (0.3 h ago) | ISS-014 |
| Spill files | (check inside the container: `ls ~/.claude/projects/*/<session>/tool-results/`) | ISS-018, 019 |
| GTD | 232 open actions / 62 overdue; inbox 21 captured / 107 processed; 4 habit outcomes (3 excused / 1 done) | — |

## Delta vs frozen baseline

Frozen: `docs/reviews/2026-09-04/agent-baseline.md`. Rows compared where the Area label matches.

| Area | Frozen (before) | Now (after) |
|---|---|---|
| Chat | 58 user messages, 58 answered. Latency p50 22 s / p90 135 s / max 211 s. 438 assistant outbound (7.5:1 agent:user) | 14 user messages, 14 answered. Latency p50 26 s / p90 195 s / max 211 s. 32 assistant outbound (2.3:1 agent:user) |
| Rituals | Morning brief 15/15 days, evening close 15/15, nightly consolidation 15/15 | Morning brief 2/2 days, evening close 1/2, nightly consolidation 2/2 |
| Eval moments | 2,306 — suppress 1,814 / ping_now 477 / ping_later 15; mismatch 130 (5.6%) | 114 — suppress 93 / ping_now 19 / ping_later 2; mismatch 7 (6.1%) |
| Mismatch shape | claimed `suppress` → actual `ping_now` 67; claimed `ping_later` → actual `suppress` 57 (79% of claimed ping_laters hollow) | claimed `suppress` → actual `ping_now` 4; claimed `ping_later` → actual `suppress` 2 (66.7% of 3 claimed ping_laters hollow) |
| Grounding | 237/477 ping_now with `grounding_calls:0` (49.7%) — contaminated by ISS-001 | 11/19 ping_now with `grounding_calls:0` (57.9%) |
| Follow-through | `close_count` sum 4, `pencil_count` sum 14 | `close_count` sum 0, `pencil_count` sum 1 |
| Durable knowledge | `note_observation` 18 (zero Aug 23–31), `upsert_fact` 6, `upsert_person` 10 | `note_observation` 22 (0 zero-days of 2), `upsert_fact` 1, `upsert_person` 0; observations index +18; note_observation/day: 09-04:22 |
| Narratives | 219 active / 4 dormant / 5 closed; `consolidate_narrative` fired Aug 21, 22, Sep 4 only; `last_consolidated_at` by month Jun 130 / Jul 68 / Aug 19 / Sep 3 | 220 active / 4 dormant / 5 closed; `consolidate_narrative` 9 calls on 1 days (09-04); `last_consolidated_at` in window 7 |
| Journal | ~4,950 entries; 1,030 "Narrative freshness" heartbeat; 1,229 `context` still `open` in the last 7 days | 349 entries; 59 "Narrative freshness" heartbeat; 179 `context` still `open` in the window (179 in the last 7 days) |
| Tool calls (audit_log) | 27,055 total; 20,700 housekeeping (76.5%) — list_narratives 9,350 / write_journal 4,952 / recall_lessons 4,009 / list_narrative_work 1,031 / list_reconcile_work 682 | 1,366 total; 747 housekeeping (54.7%) — write_journal 349 / recall_lessons 184 / list_narrative_work 77 / resolve_journal 46 / list_reconcile_work 37 / note_observation 22 / get_gtd_health 20 / read_journal 16 / read_user_model 16 / recall_everything 16 |
| Cost telemetry | `ll5_turn_costs` last doc 2026-07-13T10:18Z | `ll5_turn_costs` 55 docs, sum cost_usd $85.91, median cached_tokens 889,395, max 3,465,428; last doc 2026-09-05T00:02:16.258Z |
| Session record | `ll5_session_history` for the live session frozen 2026-08-27T06:21Z, `message_count 264`; docs/month Jul 1,836, Aug 3 | `ll5_session_history` 8 distinct session_ids indexed in the window; newest indexed_at 2026-09-05T00:02:18.620Z (0.3 h ago) |
| Spill files | 8.1 MB under the live session's `tool-results/`; 362 MB under `~/.claude/projects` | (check inside the container: `ls ~/.claude/projects/*/<session>/tool-results/`) |
| GTD | 229 open actions / 62 overdue; inbox 20 captured / 107 processed; 60 habit outcomes (36 done / 15 missed / 5 excused / 3 skipped) | 232 open actions / 62 overdue; inbox 21 captured / 107 processed; 4 habit outcomes (3 excused / 1 done) |

New rows without a frozen counterpart: `Session restarts (journal)`, `CONSOLIDATE-TALLY`.

## Method

Read-only, from a laptop. Elasticsearch is internal-only on the box, so every query runs inside the awareness container over SSH using its `ELASTICSEARCH_URL` (a node helper derives the Basic-auth header from the URL credentials; nothing secret leaves the box or is printed). One batched request list per run. Aggregations: `date_histogram` per day (UTC) and `terms`/`filter` aggs on the fields named in the frozen Method section; reply latency is the user→next-assistant gap over non-system `ll5_chat_messages`; rituals are day-counts of journal entries whose content matches the phrase. GTD via `psql` in the postgres container. Spill files are not visible from ES — check inside the agent container.

