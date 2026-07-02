# Companion Usability Plan — planning beats, habit contracts, grounded action

Implements DECISION-018 (planning rhythm), DECISION-019 (habit contracts),
DECISION-020 (grounded action). Source: the Jun 25 – Jul 2 2026 system + audit
review (932 eval moments, 27 sessions, week of journal/GTD/chat/audit telemetry).

Guiding principle from the review: **only deterministic machinery survives** —
agent initiative and user pickup both decay. Every phase therefore pairs a persona
change with a scheduler/guard/metric that doesn't depend on the agent choosing.

---

## Phase 0 — Trust + instrumentation (small, do first)

Goal: stop the trust bleed and make the metrics trustworthy before building on
them. No new stores.

1. **Verify eval recorder semantics** (DECISION-020 §6).
   - Investigate the 138 `claimed suppress / actual ping_now` mismatches and the
     Jul 1 inversion (131 ping_now / 28 suppress vs ~1:3 on every other day) in
     `ll5_eval_moments`. Suspects: `message_sent` detection counting non-user
     deliveries (journal? channel echoes?), moment recorded before/after delivery,
     Jul 1 3-way change side effect.
   - Fix `ll5-run/.claude/hooks/lib/eval_record.py` accordingly; extend
     `test_eval_record.py`. Deploy: ll5-run.
2. **One-sided-thread guard** (DECISION-020 §3).
   - messaging MCP: compute per-conversation outbound visibility (outbound rows in
     trailing 30d, or account capability flag); expose `visibility:
     full|inbound_only` on `query_im_messages` / conversation tools. Tests.
   - ll5-run persona + composite-trigger dispatch: unanswered/stale-thread claims
     require `visibility: full`; `inbound_only` threads surface only with the
     blindness stated. Deploy: messaging + ll5-run.
3. **Relative-time resolution rule** (DECISION-020 §4).
   - Persona: resolve relative expressions against the source message timestamp;
     every user-facing schedule commitment states the resolved absolute day
     ("tomorrow (Fri Jul 3)"). Governed lesson recorded so it survives.
4. **Sensor-before-assertion hard rule + lookup map** (DECISION-020 §1).
   - ll5-run CLAUDE.md: new Hard Rule + the claim-class → source table (physical →
     `where_is_user`; schedule → live `list_events`/`list_ticklers`; thread →
     `query_im_messages`; tasks → GTD; person/topic → `get_person` + narratives +
     `recall_everything`).

Verification: 48h skill-watch style trace — sample user-facing assertions and
check the paired lookup call exists in the session; mismatch metric plausible
again (mismatches ≈ genuine hollow claims only).

## Phase 1 — Evening close beat + staged-item collection (DECISION-018 §1-2)

1. **Gateway `scheduler/evening-close.ts`** (register in `scheduler/index.ts`).
   - Fires daily at `evening_close_hour` (default 20:30 local, effective-tz via
     `pickEffectiveTimezone` like other schedulers; knobs under
     `user_settings.scheduler.evening_close_*`; top-of-window gate like
     narrative-consolidation to survive restarts).
   - Builds the **embedded collection**: (a) PG `chat_messages` — today's
     assistant, non-compact, silent/staged-level messages with no later user
     message in the conversation; (b) ES `ll5_agent_journal` — today's
     still-open entries (proposals/loose ends); (c) once Phase 3 ships, today's
     `gtd_habit_log` outcomes. Truncate each item to a line; cap the list (~10).
   - Inserts `[Evening Close]` system message: the collection + the skill contract
     (one message, ≤3 loose ends, tomorrow's ONE thing, habit outcomes, per-item
     pick-up/drop calls). Unit tests per scheduler-test conventions.
2. **ll5-run skill `.claude/skills/evening-close/SKILL.md`** (dir format,
   registered — flat files don't register). The 2-minute close discipline; output
   at notify level; explicitly forbid re-staging silently.
3. **Staging contract in persona**: silent staging = deferral, not delivery; every
   staged item must resurface at a beat or be dropped explicitly.
4. **Channel dispatch**: add `[Evening Close]` to the ll5-channel dispatch map
   (invoke the skill; inline fallback per the consolidate-skill lesson).

Deploy: gateway + ll5-run together. Verify: nudge fires at 20:30 local with a
real embedded list; one notify-level close lands; staged items from that day
appear in it.

## Phase 2 — Weekly review session + solo fallback + GTD hygiene (DECISION-018 §3)

1. **Gateway `weekly-review` scheduler changes**:
   - On fire: also create the calendar block (tickler `kind: reminder`, 30-45 min)
     if not present; nudge text rewritten to "open with the first concrete
     question" (never options).
   - Book a **+45 min follow-up check** (same mechanism as wake-scheduler one-off
     or a second scheduler tick): if no user message since the session opening,
     insert `[Weekly Review — Solo Fallback]` instructing the solo pass.
2. **ll5-run `review` skill update**: two modes. *With user*: existing 7-phase
   flow, first-question opening. *Solo*: run the full pass alone; deliver a
   one-pager — project/inbox/overdue state, archive proposals (30+ days untouched
   → someday; groceries → shopping list via gtd tools), rebuilt suggestible-pool
   note, **≤3 short-reply decisions** for the user.
3. **GTD decay tooling** (gtd MCP, only if the solo pass proves clumsy with
   existing tools): `stale_actions({days})` returning archive candidates;
   otherwise reuse list/update tools.
4. KPI wiring: weekly-review completion (session or solo) becomes checkable —
   solo one-pager message or review-session row.

Deploy: gateway + ll5-run (+ gtd if 3). Verify on the next Friday cycle: session
opens with a question; absent engagement, solo one-pager lands by ~15:00 with
archive proposals.

## Phase 3 — Habit contracts (DECISION-019)

1. **gtd migration**: `gtd_habits` + `gtd_habit_log` tables (schema per
   DECISION-019).
2. **gtd MCP tools**: `create_habit`, `update_habit`, `log_habit_outcome`,
   `list_habits`, `habit_trends`. Repository-interface pattern; unit tests.
3. **Gateway `scheduler/habit-scheduler.ts`**: 60s tick (WakeScheduler shape);
   due-step → `[Habit Check]` agent instruction (habit, step level, check to
   perform); occurrence closed by a log row silences later steps; end-of-day
   auto-`missed`. Effective-tz wall-clock compare (DST-safe), per-day dedup —
   copy the wake-scheduler patterns. Tests.
4. **Beat integration**: evening-close embeds today's outcomes (Phase 1 hook);
   weekly review includes `habit_trends`; persona: two skips/week = named
   observation + smaller-doorway offer.
5. **Ritalin migration**: create the 3 dose habits (`check_kind: gtd_action`,
   current escalation steps as JSON); run in parallel with the legacy wakes for
   3 days; verify every step fires + escalates + goes quiet on logged outcomes;
   then cancel the ~9 legacy wakes. Next habits: training (`check_kind: data` vs
   health activities), sleep timer, bright-lines.

Deploy: gtd + gateway together, then ll5-run persona/skill refs. Health-critical
path — verify before retiring legacy wakes.

## Phase 4 — Prep dossiers + forward-work floor (DECISION-018 §4, DECISION-020 §2, §5)

1. **Calendar-review nudge** (gateway): add the mechanical prep obligation — for
   each prep-needing event in 48h, book the prep THIS turn (`create_wake`/
   tickler); the governor only credits `ping_later` when a booking happened
   (already true since 2026-07-01).
2. **ll5-run calendar-review/meeting-prep skill**: dossier step — participants →
   `get_person` + narratives + open GTD mentions + recent thread activity; brief
   leads with known-context ("open since Apr 9: PIP form for Hen").
3. **`eval_record.py`**: count `grounding_calls` (lookup-class tools this turn)
   per moment; ship in the eval-moment payload; index field in
   `GATEWAY_INFRA_INDICES` mapping.
4. **Anomaly checks** (one object each in `buildChecks()`):
   `behavior.forward_work_stalled` (no `ping_later` moment in 48h → warning) and
   `behavior.ungrounded_pings` (`ping_now` with `grounding_calls == 0` rising).
   Tests alongside the existing anomaly suite.
5. **Two-week checkpoint**: if prep-turn `grounding_calls` doesn't move, fall back
   to gateway-embedded dossiers in the nudge payload (DECISION-020 alternative).

Deploy: gateway + ll5-run.

## Phase 5 — Today plan card (DECISION-018 §5, after beats prove out)

- Day-plan artifact assembled from the beats (morning decision, tomorrow's-one-
  thing, booked preps, habit checks); gateway `GET /plan/today`; dashboard card +
  Android "Today" card (Active-tab pattern). Spec the store when Phase 1-2
  engagement data says what the card must show. Not started until beats have two
  weeks of data.

---

## KPIs (weekly, from existing telemetry)

| Metric | Source | Baseline (Jun 25 – Jul 2) | Direction |
|---|---|---|---|
| `ping_later` moments/day | ll5_eval_moments | ~0 (1 total) | ≥1/day |
| Evening-close engagement (user reply ≤2h) | chat_messages | n/a (beat doesn't exist) | >50% of beats |
| Weekly review completed (session or solo) | review one-pager / session rows | 0/1 | 1/1 every week |
| Staged items resurfaced vs dropped silently | evening-close collection size vs pickups | 0% resurfaced | 100% resurfaced-or-dropped |
| GTD: overdue count / inbox size | gtd_horizons / gtd_inbox | 76 overdue / 48 inbox, rising | falling |
| Habit outcomes logged (vs silence) | gtd_habit_log | Ritalin only, via GTD actions | all active habits, incl. `missed` |
| Troubleshooting share of user messages | session review (or msg classification) | ~20% | <10% |
| `grounding_calls` on ping_now turns | ll5_eval_moments | unmeasured | ~0 zero-lookup pings |
| decision_mismatch (post Phase-0 fix) | ll5_eval_moments | 140/932 (suspect) | trustworthy, then falling |

## Sequencing and dependencies

- Phase 0 has no dependencies — do immediately (it also fixes the metrics later
  phases are judged by).
- Phase 1 before Phase 2 (the solo-review one-pager and staged-item discipline
  both lean on the beat contract); Phase 3 integrates into Phase 1's beat but
  only depends on it for surfacing (can build in parallel).
- Phase 4's anomaly checks depend on Phase 0's recorder fix.
- Every deploy follows the standing rules: push to main (CI), post-deploy
  monitor until verified; gateway+ll5-run pairs ship together when nudge text
  and skill/persona must agree.
