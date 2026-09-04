# LL5 Progress

Current state of the LL5 personal assistant system.

---

## 2026-09-04 — Track B merged: MCP result caps + cursors (ISS-019), tolerant schemas for 9 tools (ISS-021)

Merged `worktree-agent-a3f693f464e523b8b` (`26e4e79`). New `packages/shared/src/mcp/result-cap.ts` (`MCP_RESULT_CAP_CHARS = 20_000`, item-boundary cut newest-first, opaque cursor, `truncated`/`next_cursor`/`hint` only when cut, `max_chars` override ≤500 KB). Applied to awareness `recall_everything` (the 1.7 MB / 700 KB results were `all_sessions:true` carrying whole session docs — now `message_count`/`transcript_chars` + 4 KB clips), `read_journal`, `query_im_messages`; personal-knowledge `recall`/`list_narratives`/`get_narrative`; messaging `read_messages`. Nine schemas now accept what the agent actually sends (`note_observation` string `subject`/`content`, `write_journal` signal `consolidated`, `upsert_fact` free shapes, `get_person` `person_id`, `create_tickler` `date`/`start`, `upsert_lesson` bare `content`, `log_habit_outcome` `skipped`, `link_media` aliases, `list_horizons` no-arg) — each locked by a test on the live failing payload; `read_messages` with `platform:"slack"` returns a structured redirect to `query_im_messages`. `write_user_model` never failed (the ISS-021 list was wrong there).

Gateway follow-up in this commit: UI/regrounding consumers pass `max_chars` (`narratives.ts` list 250 KB + `get_narrative` 200 KB, `server.ts` regrounding list 100 KB) so dashboards aren't cut to the first ~20 KB page. Tests: shared 127, awareness 229, personal-knowledge 122, gtd 148, google 49, gateway 815 — all green after `npm run build` in `packages/shared` (a stale `shared/dist` on main made 52 tests + 3 typechecks fail until rebuilt — see HANDOFF). Messaging: 84/87, the 3 `contact-settings-tools` failures pre-date today.

Proposed persona text for `packages/ll5-run-shared/CLAUDE.md` (`create_tickler` field names, `upsert_fact` shape, `note_observation` fields, Slack via `query_im_messages`) is recorded in ISSUES under ISS-021 for Phase 2.

## 2026-09-04 — ISS-023 verified: a docs-only push no longer redeploys the stack

Run 33895111679 for the docs-only merge `f2ba560`: `detect-changes` green, `build: skipped`, `deploy: skipped`. Every docs commit before today bounced all 10 services.

## 2026-09-04 — The agent rolled. Track A verified live.

Second dispatch after the resolver fix: build (tripwire `2.1.204 == pin`) → deploy → `reprovision-running: reprovisioned:1` at 16:22:14Z → new container, `[entrypoint] claude version OK: 2.1.204 == pin 2.1.204`, fresh tmux session, new session id `75a982f2…`. Hooks wired in the image: `spill-read-block.sh` (PreToolUse) and `turn-cost.sh` (Stop) alongside the existing ones.

Verified from the new container within two minutes:
- **ISS-014/015 verified:** `session-save.log` → `ok http=201 append msgs=4/4`; `ll5_session_history` doc for the new session `indexed_at 16:23:55Z` and advancing each Stop. The re-ground now reads live data.
- **ISS-006 writer live:** first `ll5_turn_costs` doc since Jul 13 — cold-start turn on `claude-opus-4-7`: 494,799 cache-write tokens (1h TTL) + 737,819 cache reads ≈ **$5.53 API-equivalent**. Steady-state turns will be ~$0.37 (reads only). This is the first time per-turn spend is visible on the Claude Code variant.
- **ISS-001 fix live:** eval record carries `ts_end`; the wrapper floors the next record on it.
- ISS-007 and ISS-024 → **verified**. ISS-018/020 → fixed (7-day verification windows).
- Oddity noted, not blocking: the orchestrator logged two `reprovision-running` completions (a `0/0` at 16:22:02Z while the tenant row was `provisioning`, then the real `1/0`); the workflow has the roll block once. Idempotent either way.

## 2026-09-04 — First end-to-end agent dispatch; orchestrator gets a token resolver (ISS-024)

The DECISION-027 path ran for real: agent-repo push → `trigger-ll5-rebuild` (with `LL5_DISPATCH_PAT`) → ll5 `repository_dispatch` → `build (run-claude)` green **with the pin tripwire** (`[verify] claude --version -> 2.1.204`) → pushed → deploy → host pulled the new `latest` (`CLAUDE_CODE_VERSION=2.1.204`). The last step failed honestly: the orchestrator answered the roll with `reprovision skipped, no agent token`.

- **ISS-024 (new, fixed):** `index.ts` never passed an `agentTokenResolver`, so the orchestrator defaulted to `() => null` — which means its stale-heartbeat restart path (`reconcile()`) has never once restarted an agent either. `SecretsWriter.readAgentToken(userId)` now reads `LL5_AGENT_TOKEN` back from the tenant's own `/run/ll5/<uid>.env`, and `index.ts` wires it. Test: write → read round-trip incl. escaped quotes; missing file → null.
- Lesson recorded in HANDOFF: the roll step is deliberately non-fatal, so **"deploy: success" ≠ "agent rolled"** — verify `claude --version` inside the container every time.
- Agent repo Track A (`b6c896f`, held until this deploys so its rebuild's roll lands): ISS-014 hook (`--data-binary @file`, `mode:"append"` tail, `session-save.log`), ISS-001 corrected root cause + fix (span carry-over — see ISSUES), ISS-006 turn-cost writer, ISS-020 core tool pre-load, ISS-017 memory outbox + drain, ISS-018 spill-read block hook.
## 2026-09-04 — DECISION-028 proposed — scaffolding subtraction (Track C)

Evidence-based proposal, no code changed: `docs/decisions/DECISION-028-scaffolding-subtraction.md` (status **proposed**). Re-measured every loop, scheduler, anomaly check and tool from the Aug 21–Sep 4 baseline against prod ES and a read-only Postgres look. Headline corrections to ISS-010: `list_narratives` 9,350 is the web chat's Active-topics rail polling `GET /narratives` every 45 s (`limit:150`, no `session_id`), not the narrative loop; the narrative loop wrote 1,028 "Refreshed 0, created 0" journal notes in 1,038 ticks; `recall_lessons` (4,033) fires on every injected system row with the `<channel>` envelope as the query and a relevance gate that cannot fail; the reconcile subsystem has had **zero input ever** (`gtd_horizons.conversation_id` NULL on all 493 rows — the selector exits at `reconcile.ts:62`); `[ALERT]` re-notify produced 845 `channel.gmail`/`channel.slack` turns; the live tool surface is 178, not 111 (118 uncalled). Proposes: retire reconcile (+5 checks, 2 tools, loop), `NarrativeConsolidationScheduler`, `JournalHealthScheduler`; merge the two expiry sweeps; gate health polling, `recall_lessons`, the loop's model spawn, response-timeout, GTD-health, character-refresh, the phone-mirror channel alerts; replace `record_moment` with a Stop-hook-parsed sentinel line; cut the agent tool surface to ~120. Net 32 → 27 schedulers, 17 → 12 checks, 2 → 1 loops. ISS-008/009/010/022 rows point at it. Nothing implemented; implementation order + per-step verification are in the document.
## 2026-09-04 — ISS-019 + ISS-021: MCP read results capped and paginated; 9 input schemas stop rejecting what the agent sends

Track B of the agent remediation. Both issues were diagnosed against the live transcript (read-only) before any code was touched.

- **ISS-019 fixed — no MCP read tool returns an unbounded payload.** The 1.7 MB / 700 KB results were `recall_everything` with `all_sessions:true` returning whole `ll5_session_history` docs (`messages` + `transcript_text`) inside `results[].data`; the nightly 50–61 KB ones were `read_journal(status:"open", limit:100)`; `list_narratives(limit:30)` reached 87 KB. One contract now lives in `@ll5/shared` (`packages/shared/src/mcp/result-cap.ts`): `MCP_RESULT_CAP_CHARS = 20_000`, `capItems()` (item-boundary truncation, newest kept, at least one item), opaque offset `cursor` (`encodeCursor`/`decodeCursor`), `pageFields()` (adds `truncated:true`, `next_cursor`, `hint` only when something was cut — small results are byte-identical to before). Applied to `recall_everything`, `read_journal`, `query_im_messages` (awareness), `recall`, `list_narratives`, `get_narrative` (personal-knowledge) and `read_messages` (messaging); every description tells the agent the cap and cursor exist and which filter narrows the query. `recall_everything` additionally never inlines a transcript (session docs → `message_count` + `transcript_chars`) and clips any single `data` string at 4,000 chars. ES-backed tools page with `from`; list tools fetch `limit + 1` as a probe so `truncated` is exact. `list_narratives`/`get_narrative` accept `max_chars` (≤500 KB, "programmatic consumers only") because the gateway (`narratives.ts`, `server.ts` regrounding) and the dashboard ask for 60–100 items per call — **those callers are not updated here** (gateway is another track's), so until they pass `max_chars` or follow `next_cursor` the narratives list/detail views show the first ~20 KB page.
- **ISS-021 fixed — 19 `-32602` failures across 10 tools reproduced with their exact inputs**, then each schema loosened where the agent's input was reasonable and locked with a test on the live payload: `note_observation` (`subject` as object/array/JSON string, `content` for `text`, `source` normalized and echoed as `normalized`) — the tool the knowledge chain depends on; `write_journal.signal` + `consolidated`/`completed` (the consolidate and backfill skills instruct exactly those); `upsert_fact` needs only the text (`content`/`value`), defaults the rest and echoes `defaults_applied`; `get_person` `person_id`; `create_tickler` `date`/`start_date`/`start`; `upsert_lesson` bare `content`; `log_habit_outcome` `skipped`; `link_media` `link_type`/`link_id`; `list_horizons` bare = all levels; `read_messages.platform` string with an `UNSUPPORTED_PLATFORM` redirect to `query_im_messages`. `write_user_model` had zero failures — the register was wrong on that one. Two persona text changes are proposed in ISS-021 (not applied; `ll5-run-shared` is another track's).
- **Tests:** shared +10, awareness +17 (2 existing `query_im_messages` assertions updated for the `limit+1` probe), personal-knowledge +18, messaging +5, gtd +4, google +4 — all real handlers via `captureTools`, schemas validated with the tool's own Zod shape. `npx tsc --noEmit` and `npx vitest run` clean in shared, awareness, personal-knowledge, gtd, google. Messaging: the 5 new + all read-messages tests pass; 3 failures in `contact-settings-tools.test.ts` pre-exist on main (verified on the untouched checkout) and are unrelated.
- **Known gap:** a worktree needs its own `npm ci` — otherwise `@ll5/shared` resolves to the main checkout's `dist` and new shared exports are invisible to `tsc`/vitest.

## 2026-09-04 — DECISION-027: one production image for the Claude agent, built by ll5 (+ ISS-023)

ISS-007 turned out to be a split-brain deploy path, not a stale tag. Two images, two pipelines, and the one that shipped was not the one that ran:

- `ll5-run-claude-code` CI built `ghcr.io/arnonzamir/ll5-agent` (CLI pinned 2.1.204) and deployed it to Coolify app `js8owk0g…` — a **zombie** (`exited:unhealthy`, 20,026 restarts, last online Aug 31). Every push there since Jul 14 built an image nobody ran.
- The **live** per-user container runs `ll5-run-claude`, built by **ll5** CI from `docker/Dockerfile.ll5-run-claude` with an **unpinned** `npm install -g @anthropic-ai/claude-code` — hence 2.1.197. Rebuilt only on manual dispatch (last Jul 19) or the Monday schedule, which **failed 7 of 7 runs since Jul 20**: `build (run-opencode)` 403s pushing a package the opencode repo owns, and matrix fail-fast cancelled `build (run-claude)`. Silent for seven weeks.
- `docker compose up` never touches per-user containers; a good build still needed an explicit re-provision to land.

Shipped (see `docs/decisions/DECISION-027-claude-variant-single-image.md`):
- `docker/Dockerfile.ll5-run-claude`: `ARG CLAUDE_CODE_VERSION` (default 2.1.204; repo var `CLAUDE_CODE_VERSION` overrides), exported as `ENV`, build fails if `claude --version` disagrees; `en_US.UTF-8` locale + `openpyxl` ported from the retired Dockerfile.
- `.github/workflows/build-and-push.yml`: `repository_dispatch` with `package=run-claude` now **builds** it (opencode stays deploy-only); schedule builds `run-claude` only; run-claude build-args carry the pin; after `docker compose up`, when this run rebuilt run-claude, the deploy job calls the orchestrator's new **`POST /runtimes/reprovision-running`** to roll every running per-user agent (`provision()` force-pulls + force-removes by name). **ISS-023 bundled:** a push touching no package now builds nothing and the deploy job is skipped (`else PACKAGES=()` + matrix gate on the deploy `if`).
- `packages/agent-orchestrator`: `Orchestrator.reprovisionRunning()` (every `running` row, no heartbeat gate, no cooldown, per-user failures collected) + the authed route. Tests +3.
- Agent repo (`ll5-run-claude-code`): `Dockerfile` and `build-and-push.yml` **deleted**; new `trigger-ll5-rebuild.yml` (push → `repository_dispatch(rebuild-agent, package=run-claude)`, needs `LL5_DISPATCH_PAT`); `docker-entrypoint.sh` asserts the CLI version against the baked pin at boot — mismatch = `critical` alert via `POST /alerts` + `~/.ll5/version-mismatch`, not a crash loop; `docker/README.md` rewritten.
- Coolify app `js8owk0g…` deleted (volumes kept — nothing mounts them). The `ll5-agent` GHCR package still needs an owner token to delete. `TS_AUTHKEY` (rotated earlier today) and `COOLIFY_API_TOKEN` on the agent repo are now unused.
- Follow-up noted in the decision: the ll5 image runs as root; the retired one ran as `node`.

## 2026-09-04 — Phase 1 (gateway side): session-save unfrozen, idempotent telemetry, declared mappings

Gateway-only pieces of the remediation plan's Phase 1 (`docs/ISSUES.md` ISS-005/006/014/015/016). The agent-repo halves wait on its deploy path (ISS-007/013).

- **ISS-014 `/sessions`:** route-scoped `express.json({limit:'10mb'})` (the live 9-day session's full payload measured **3.87 MB for 7,807 messages**, so the existing hook resumes saving on its next Stop with no agent change — the freeze since Aug 27 ends on deploy). New **`mode:"append"`** for the durable fix: caller sends only a tail, gateway keeps stored messages and appends those newer than the stored `last_message`, optimistic-concurrency guard (`if_seq_no`/`if_primary_term`, 409 = retryable), 403 on a cross-tenant doc. Both modes cap stored messages at 5,000 (`messages_dropped` counted) and project `transcript_text` from the **newest** 200k chars — it was the oldest 200k, so a long session's recent turns were never searchable by `recall_everything`.
- **ISS-016 (partial):** `agent.session_save_stale` anomaly check — 24h on `ll5_session_history.indexed_at`. Scoped on `user_id.keyword`: the index is dynamic-mapped, and a `term` on the analyzed `user_id` matches nothing, so the check would have silently never armed. `lastDocAgeMinutes` gained an optional `userField` for exactly this.
- **ISS-005 fixed:** `indexOnce()` — `/telemetry/eval-moment` and `/telemetry/turn-cost` now write with id `${session_id}:${ts}` + `op_type:'create'`; a retried/double-fired Stop hook lands as a 409 → `{ok:true, duplicate:true}` instead of a second doc feeding the rate-shift baselines.
- **ISS-006 (partial):** declared mappings for `ll5_turn_costs` and `ll5_reconcile_metrics`. `ensureIndices` is create-if-missing, so prod's existing indices stay dynamic; this protects fresh deploys. The `turn_costs_stale` check is held until the writer ships (it would fire immediately and stay red).
- Tests: +13 (`eval-moment-route.test.ts` idempotency ×5, `/sessions` ×7; `anomaly-monitor.test.ts` ×1). Gateway suite 815/815, typecheck clean.
- **Expected side effect, not a regression:** once ISS-001 (agent-side) lands, recorded `ping_now` will drop sharply — that is the over-count being removed.
- **Post-deploy verification corrected the root cause.** The gateway came up healthy on the new image, a manual POST of the real 3.87 MB payload returned 201 — but the hook itself still fails on every Stop: `session-save.sh` passes the payload as one argv string (`curl -d "$PAYLOAD"`) and Linux caps a single argument at 128 KB → `curl: Argument list too long` (exit 126), reproduced in the container. 128 KB ≈ 250 messages — the exact freeze point. The gateway cap was the second wall. Agent-side fix (`--data-binary @file` + append mode + error logging) is now the blocking item, gated on the agent deploy path (ISS-007). Live doc unfrozen once by hand (15:25Z, 7,818 messages); `agent.session_save_stale` will fire again in 24h, correctly, until the hook ships.

## 2026-09-04 — Agent review (Aug 21–Sep 4): issue register + frozen baseline

First look at the agent in 2+ weeks (nothing shipped to either repo in the window). Chat and rituals healthy: 58/58 user messages answered (p50 22 s), morning brief / evening close / nightly consolidation 15/15. The memory layer is not — and it failed silently (1.57M `ll5_app_log` docs, 1 error, no alert).

- **New `docs/ISSUES.md`** — the single living issue register, 22 issues seeded (ISS-001..022) + the 3 old Known Issues folded in as ISS-K01..K03. `## Known Issues` below now points at it.
- **New `docs/reviews/2026-09-04/agent-baseline.md`** — the 15-day numbers frozen as the control for the remediation plan; re-run after each phase.
- Headline findings: `note_observation` drifted 963 → 11/month over three months while `write_journal` tripled (the CLAUDE.md "journal **or** observation" rule let the cheap half win — ISS-002); narrative consolidation silent 12 days as a consequence (ISS-003); `POST /sessions` 413s silently past ~250 messages on the gateway's 1 MB body cap, so `ll5_session_history` is frozen per session and every post-compaction re-ground read an 8-day-old snapshot (ISS-014/015); eval recorder still over-counts `reply` as delivery (ISS-001 — Aug 21: 183 recorded pings vs 24 real); agent greps spilled `tool-results/*.txt` files instead of narrowing ES queries (ISS-018/019); live CLI 2.1.197 ≠ Dockerfile pin 2.1.204 (ISS-007); `ll5_turn_costs` dead since Jul 13 (ISS-006); reconcile subsystem 0 actions in 15 days (ISS-008); 76.5% of tool calls are housekeeping (ISS-010).
- Memory governance verified **working**: `memory-intercept.sh` denies markdown memory writes and routes to `ingest_memory`; container memory dirs empty. Nothing goes to disk as a read source — but `ingest_memory` hasn't been fed since July (ISS-017).
- Decisions taken: fix telemetry + knowledge first, runtime upgrade **last** against the baseline; scaffolding subtraction is on the table (DECISION-028 to come; 027 became the deploy-path decision); one controlled session restart per day, event-triggered after nightly `consolidate` (ISS-016); memory-intercept goes fail-closed + outbox (ISS-017); core tool set pre-loaded at SessionStart (ISS-020). Plan phases 0–6 are in the session plan; Phase 0 is this commit.

## 2026-08-19 — Suppression alert now keeps BOTH metrics (count + share)

`behavior.suppress_spike` fired at 15:10 local claiming the agent was over-suppressing. It wasn't. Pulled the eval moments for the exact window the check measured (09:10–12:10Z) against its own three same-weekday baselines:

| Date | moments | suppress | ping_now | share |
|---|---|---|---|---|
| **08-19** | **37** | **32** | 5 | **86.5%** |
| 08-12 | 18 | 13 | 5 | 72.2% |
| 08-05 | 5 | 2 | 3 | 40.0% |
| 07-29 | 28 | 23 | 5 | 82.1% |

Suppress **count** 32 vs a 13 median = 2.46× (tripped). Suppress **share** 86.5% vs 77.2% = +9.3pp. Total moments 2.06×. `ping_now` was **5 on every comparable day** — the agent delivered exactly as many proactive messages as usual, it just had twice the events (new-phone/eSIM provisioning burst) and declined the extra ones. Volume change, not behavior change.

Fix: `RateShiftCheck` gains an optional `shareGate` — a rate-shift may now require the metric to move as a **share of a denominator population** as well as in absolute count, and the alert value reports both (`32 in the last 180m vs 13 median…; share 86.5% of 37 vs 77.2% median (+9.3pp)`). Wired onto `behavior.suppress_spike` with `minPoints: 20, minDenominator: 12`. Self-arming like every other check: failed denominator query, too-small denominator, or no usable share history → no alert.

The margin is in absolute **percentage points**, not a multiplier — a share is capped at 100%, so "2× the baseline share" is unsatisfiable once the baseline passes 50% (72.2% × 2 = 144%) and a multiplicative gate would have silently never fired. Calibrated on the real data: today's false positive sits at +9.3pp; a genuine can't-act regime drives the share toward ~100% (+23pp or more from a 72% baseline).

Landmine found while building it: the existing `median()` helper **rounds to an integer** (its callers compare doc counts). Feeding it shares would round a 0.72/0.82 two-sample median to 1.0 and make the gate unsatisfiable. Added `medianFraction()` and a test that locks the even-sample case. Gateway 802 tests green (+5), tsc clean.

---

## 2026-08-19 — WhatsApp lifecycle status never persisted (silent, `.catch`-swallowed)

Surfaced while verifying a live WhatsApp re-pair after a phone swap. Every connection-lifecycle transition logged `[whatsappLifecycle] status update failed — error: inconsistent types deduced for parameter $3` at `warn` and wrote nothing.

Cause: the `UPDATE messaging_whatsapp_accounts` in `processors/whatsapp-lifecycle.ts` binds `$3` twice — as the assigned value (`SET status = $3`) and inside a CASE comparison (`$3::text = 'open'`). Only the comparison carried the cast, so Postgres deduced conflicting types for the parameter and aborted the whole statement. The code comment directly above already claimed the cast was there for exactly this reason — it had been applied to the wrong bind site, so the comment read as correct while the bug stayed live.

Impact: the account row's `status`/`last_error`/`last_seen_at` froze at whatever was last written by another path. Observed live — the row read `reconnecting` with `updated_at` 11h stale while WhatsApp was actually logged out for 6h 48m. Anything reading that row for WA health (dashboard, agent) saw a lie; the `whatsapp_disconnected` alert was unaffected (separate path), which is why the outage was still caught.

Fix: `SET status = $3::text`. New `whatsapp-lifecycle-status.test.ts` (2 tests) is a source-level tripwire asserting BOTH bind sites carry the cast — a live PG round-trip is the only thing that reproduces the type deduction, so a mock-pool test can't catch the failure itself, only the SQL shape that causes it. Gateway 797 tests green, tsc clean.

Same session, no code change needed: `behavior.suppress_spike` fired 15:10–15:40 local (32 suppressed proactive turns in 180m vs a median of 13). Not a broken tool — a new-phone/eSIM provisioning burst (Google security alerts, carrier SMS) on top of a busy morning, which the agent correctly declined to ping about. Confirms a known limit of that check: it counts absolute `decision:suppress` docs, not a suppression *rate*, so a volume spike reads as a behavior regression. A ratio, or a gate on total eval moments in the window, would keep it quiet. It did lead the `whatsapp_disconnected` alert by ~55 min.

---

## 2026-07-19 — Authority requests could expire into a black hole (+ nameless approval cards)

Four `permission_change_requests` filed 2026-07-17 20:28–20:43 (agent asking to downgrade its own authority `agent → input` on two people) were still `status='pending'` two days later, past their `expires_at`. Nothing ever reaped them.

The bug is the interaction of three correct-looking pieces: both surfaces that render a request — `GET /approvals/pending` and the Needs You tray (`collectContactApprovalItems`) — filter `expires_at > now()`, and the only code that flips a row to `'expired'` is `approvals.ts:116`, which runs **when the user decides the request**. So at the deadline the card silently vanished from the UI while the row stayed `pending` forever: the user could no longer decide it (not shown) and the agent was never told it had lapsed. `TrayItemExpiry` already solved exactly this for `tray_items`; authority requests had no equivalent.

Fix: new `scheduler/permission-request-expiry.ts` (`PermissionRequestExpiry`, knob `permission_request_expiry_minutes`, default 10), registered next to `TrayItemExpiry`. Same deliberately-dumb contract — flip lapsed `pending` rows to `'expired'` + `decided_at=now()`, then one `[Authority]` system message per row telling the agent the change was **NOT** applied and the prior authority stands. **Default is deny**: an unanswered request changes nothing, so `contact_settings.permission` is untouched. Authority is only ever granted by an explicit human decision through `POST /approvals/:id/decide`. 42P01-defensive like the tray sweep. 7 tests.

Second bug found in the same trace, and the reason those cards were unanswerable in practice: `contact-settings.ts` `resolveTarget()` hardcoded `displayName: null` on the `person_id` branch. Every request the agent filed by person_id (all four) produced a card reading *"May I handle this conversation as 'input'?"* — no name. Now looks the name up from `messaging_contacts` by `person_id` (first row with a non-null `display_name`, still null-tolerant).

**Follow-up same day — gap closed.** Added `GET /approvals/history` (caller-scoped, every status, `limit` clamped 1..500, default 100) plus an **Authority log** tab in Settings → Contacts: who the agent asked about, the requested change (`from → to`), the outcome, and when it was decided. A `pending` row already past `expires_at` renders as expired rather than actionable, so the ≤10-min gap before the sweep runs never looks answerable. The tab's count badge shows only what still genuinely needs the user. Contact-only chrome (search, platform filter, contact column headers) is hidden on it. History is fetched on tab open, not with the page.

Also widened the TTL: migration 044 moves the `expires_at` default from 24h to **72h**. 24h could not survive a weekend — these four were filed Friday ~20:30 and lapsed Saturday evening, entirely inside the Fri/Sat weekend, so the user never had a waking chance. DEFAULT only; existing rows keep their original deadline. Expiry stays fail-safe — this only widens the window in which the user can say yes.

Original gap as found, now fixed by the above: there was **no permissions-history surface**. `permission_change_requests` has zero readers in the dashboard — Settings → Contacts shows current permission state only, and there is no audit-log UI anywhere, so a lapsed or rejected request leaves no trace a user can browse. Only the live tray and the FCM push ever showed it.

Also this session: the gateway's `OPENCODE_SERVER_URL` was stale at `http://agent:4096` while the box runs the Claude Code variant (`ll5-run-claude`, no listener on 4096), so every scheduler/alert `triggerAgent` threw `fetch failed`. Delivery was unaffected (the agent pulls via `/chat/listen` SSE) but every alert logged a warn and burned sweep retries. Root cause was the GitHub secret `AGENT_VARIANT` still set to `opencode`; the compose/CI single-var contract derives the URL from it. Secret set to `claude`, redeployed, verified: `OPENCODE_SERVER_URL` empty, `[AgentTriggerListener] Not starting`, zero trigger warns, agent SSE reconnected.

---

## 2026-07-15 — Persona: concentrated by default (shorter messages to the user)

User asked for less-lengthy, more concentrated agent messages. Shifted the persona default in `packages/ll5-run-shared/CLAUDE.md`: the temperament section's "Chatty is the default for direct chat" is replaced with "Concentrated by default — lead with the point, stop when it's made; length is earned, not default" (warmth is tone, not word count; extra lines only when the content needs them, and structured when used). Added a matching Emotional-Contract bullet ("Brevity is respect"). Live on the next agent image rebuild + re-provision.

---

## 2026-07-14 — Agent hooks were unwired in the variant image (silent, ~33h)

Two yellow anomaly alerts ("Pencil-the-timeline reflex stalled", "Forward work (ping_later bookings) stalled") were **false positives**: the agent was penciling normally (`create_tickler` 3× on Jul-14). Both checks read `ll5_eval_moments`, and that index had been frozen since 2026-07-13 10:30Z (0 docs in 24h) — because **every Claude-Code hook stopped running** when the container moved to the unified variant image (`ghcr.io/arnonzamir/ll5-run-claude:latest`, built Jul-13 14:28).

Cause, two bugs stacked: `docker/Dockerfile.ll5-run-claude` COPYed `variant-content/.claude/hooks/` (the hook scripts) but never the variant's `.claude/settings.json` (the `hooks` wiring), and `scripts/render-mcp-config.ts` then **overwrote** `/workspace/.claude/settings.json` with an `mcpServers`-only object. Result: 12 hooks across 7 events silently dead — eval-record, stop-mirror + cli-input-mirror (conversation unify), session-start/session-save, precompact-backup, memory-intercept/recall, narration-watchdog, repo-write-block, cron-block, and the **external-authority gate** (the DECISION-021 security hook).

Fix: (1) `render-mcp-config.ts` now MERGES `mcpServers`/`mcp` into an existing output file, preserving every other top-level key (`hooks`, `permissions`, `channelsEnabled`); (2) the Dockerfile COPYs the variant's `settings.json` before the render step; (3) a build-time tripwire (`RUN node -e …`) fails the image if the rendered settings has no `hooks` or no `mcpServers`; (4) `docker-entrypoint.sh` (ll5-run-claude-code) strips `hooks` when it merges the rendered file into `$HOME/.claude/settings.json` — the rendered file doubles as the PROJECT settings (cwd `/workspace/ll5-run` → symlink → `/workspace`), and leaving hooks in both would fire every hook twice (two eval records, two mirrored messages per turn). The `$HOME` merge itself only landed 2026-07-13 (`59ec9eb`), which is what introduced the duplicate-hook hazard.

Gap closed in the same pass: new anomaly check **`telemetry.eval_moments_stale`** (12h staleness on `ll5_eval_moments`, unfiltered) watches the eval WRITER itself, and its suggestion says to distrust every `behavior.*` alert while it fires. Threshold picked from real data — over the 16 days before the outage the worst inter-arrival gap was 8.7h (p99 = 1h), so 12h clears every genuine quiet stretch. It would have caught this the same day instead of never.

---

## 2026-07-13 — GTD: actions can finally be linked to projects from the UI

The backend always supported it (`project_id` FK on actions; `create_action`/`update_action` accept it; `list_actions` filters by it) but no UI surface exposed it, so the projects view was a read-only list of orphan cards. Now: a **Project picker** in the action create + edit dialogs (with a `none` sentinel that unlinks) and a **Project filter** in the actions filter bar; a new **`/projects/[id]` detail page** — header (status/category/description + Edit), the project's actions with complete-toggle, **New Action** (created pre-linked), **Link Existing** (picks from active actions with no project), and per-row **Unlink**; **New Project** button + status filter on the projects grid (cards now navigate to the detail page instead of opening an edit dialog).

Also fixed: `updateProject` in the dashboard sent `project_id` to the `update_project` tool, which requires `id` — every project edit from the UI was failing schema validation. New gtd tool `get_project` (wraps the existing `findProjectById` repo method) so the detail page can load a project of any status; +2 tests (144 gtd tests pass).

---

## 2026-07-13 — Claude-Code variant selectable + generic multi-variant config

The agent config is now variant-aware: `model_config.variant` = `opencode` (per-slot multi-provider, the default) or `claude` (Claude-Code subscription image). New provider `claude-code` holds the subscription OAuth token. Orchestrator picks the image by variant (not provider-inference) and emits CLAUDE_CODE_OAUTH_TOKEN + ANTHROPIC_MODEL for the claude branch. The Claude-Code entrypoint (ll5-run-claude-code) now works under the per-user orchestrator: sources the mounted secrets file, accepts token OR anthropic key, skips USERNAME/PIN login when LL5_TOKEN is injected. UI: a Runtime toggle (opencode | Claude Code) that swaps the keys section + shows a single Claude-model picker for the claude variant.

---

## 2026-07-12 — Multi-provider per-slot agent models (redesign)

Agent model config is now multi-provider: a key per provider (Zen / Groq / Anthropic-direct), a top-level default {provider, model}, and per-slot {provider, model} for main/grounder/narrative/reconcile/image/audio (each slot filtered to text/vision/audio-capable models). Backend: migration 043 (provider_keys + model_config JSONB on agent_llm_credentials, backward-compatible; relaxed ciphertext NOT NULL); gateway `agent-models.ts` catalog + endpoints (model-catalog, model-config, provider-key, delete). Orchestrator loadCredential/secrets emit LL5_DEFAULT_* + LL5_SLOT_<X>_PROVIDER/_MODEL + all three keys; the agent entrypoint maps abstract→runtime opencode providers (opencode/opencode-ds/groq/anthropic-direct). UI redesigned: API-keys section + default row + one provider/model row per slot. Legacy single-credential rows backfill so the running agent never breaks.

---

## 2026-07-12 — Image + audio analysis tools (text-only agent can now see/hear)

deepseek is text-only, so images/voice notes were unseen. Added `inspect_image` (Zen vision, default claude-haiku-4-5) and `transcribe_audio` (Groq Whisper, default whisper-large-v3, needs GROQ_API_KEY) to the agent channel plugin, plus two new UI model slots (`image`, `audio`) in AGENT_MODEL_SLOTS. Orchestrator passes GROQ_API_KEY through to per-user env-files. WhatsApp already embeds `[<mediaType> attached: /uploads/…]` in content, so the agent gets the path; CLAUDE.md now instructs it to call the tools before responding. **Action needed: set GROQ_API_KEY in the deploy env to enable audio.**

---

## 2026-07-12 — Chat: per-turn model+cost footer, tool-call mirroring, spend telemetry

Chat bubbles now show a meta footer (time; + model, tokens, cost for assistant turns). The agent mirrors each work tool call to the thread as a folded compact row with full args+result on expand (`kind:"tool-call"`, main session only, comm tools skipped). New `POST /telemetry/turn-cost` persists real per-turn usage (opencode token counts × verified Zen price table) to ES `ll5_turn_costs` — spend is now queryable by day/model/agent (previously nothing persisted tokens or cost). Also fixed: `narration-watchdog` "Still on it…" now fires only for the MAIN session (background workers/grounder no longer leak it). Agent-side in ll5-run-opencode: `tool-mirror.ts`, `model-cost.js`, stop-mirror metadata.

---

## 2026-07-11 — Retire the shared agent from auto-deploy (compose profile)

The legacy shared single-tenant `agent` service kept resurrecting on every `docker compose up -d` deploy and re-registering the (single) user's `agent_session_id`, colliding with the per-user orchestrator container (per-user triggers 404 on a session that lives on the old agent). Gated `agent` behind the `shared-agent` compose profile so normal deploys skip it; the deploy's agent health-check is now informational. Kept for rollback: `docker compose --profile shared-agent up -d agent`. Stop the currently-running one + reclaim the session on the per-user container to finish the cutover.

---

## 2026-07-11 — Fix: console SPA blank (forwardAuth cookie never reached the browser)

The console loaded its index (200) but every SPA asset/API/SSE follow-up 401'd — the opencode UI came up blank. Cause: Traefik `authResponseHeaders` copies the forwardAuth Set-Cookie onto the UPSTREAM request, not the client, so a "200 + Set-Cookie" never planted the console cookie in the browser. Fix: on the query-token hit, `/internal/console-auth` now returns a 302 + Set-Cookie to the token-stripped URL (Traefik passes non-2xx auth responses through to the client); the browser sets the cookie, follows the redirect, and subsequent requests authenticate via the cookie branch. +4 endpoint tests.

---

## 2026-07-11 — Orchestrator force-pulls the image before provision

Fixes the day's recurring "the fix didn't take" trap: `docker pull` on the host reported "up to date" without refreshing the `:latest` digest, so orchestrator provisions silently ran STALE local builds. `DockerRuntime.provision` now `pullImage(spec.image)` first — best-effort (auth failure / network → falls back to the local image, no regression). Private GHCR → `GHCR_PULL_TOKEN`/`GHCR_PULL_USER` (reuses `GHCR_READ_PAT` + `arnonzamir`, injected into `.env` by the deploy). Full session recap in docs/SESSION-2026-07-11.md.

---

## 2026-07-11 — Inner voice: folded/dimmed + expandable (chat UI)

The agent's thinking (grounding briefs, "Processing…", "Let me search…") was flooding the thread as full chat bubbles. Two-part fix so it reads like the Claude-era UX: (1) variant stop-mirror `classifyMirror` marks inner-voice/working-note prose as `display_compact` (dimmed folded row) and honors `[[silent]]`/`[[compact]]` prefixes — only real answers become full messages; (2) dashboard CompactRow is now click-to-expand (folded one-liner ↔ full text) for BOTH inner-voice rows and tool-call markers. So everything's available, dimmed/folded, expandable.

---

## 2026-07-11 — opencode-go plan support (pro, uncapped) + model wiring

Root-caused the silent agent: deepseek-v4-flash-free (a reasoning model) returns EMPTY content on the agent's large-context turns (reasoning exhausts the output budget), and every PAID model on the `opencode` provider is capped at $62. The fix is the **opencode-go plan**: a distinct Zen endpoint `https://opencode.ai/zen/go/v1` (NOT under the $62 cap) that runs deepseek-v4-pro/glm/etc. Verified pro works there with the go key. Wiring: opencode.json defines opencode-go as a custom provider (the container registry lacked it); entrypoint writes auth.json under OPENCODE_PROVIDER_ID and patches opencode.json model to `<provider>/<model>`; orchestrator loadCredential returns zenProvider (opencode|opencode-go) and secrets emits OPENCODE_PROVIDER_ID accordingly; gateway triggerAgent NO LONGER injects a per-turn model (the container owns model selection now). Model change → re-provision to apply.

---

## 2026-07-11 — Model config: opencode-go provider + all Zen models

Added `opencode-go` as a selectable provider (same Zen backend as `opencode`, a different account/key; the container always runs provider id "opencode", only the stored key differs — orchestrator maps it). Expanded the opencode model catalog to the full Zen list (~55 models) and made model validation permissive for opencode/opencode-go (any non-empty model — the catalog is a UI hint, not an allow-list — so new Zen models work without a code change). Anthropic stays strict. Dashboard picks it up via the catalog. Also reverted reactive grounding to proactive-only after it wedged the agent (recursion storm) — reactive memory now via memory-recall + correction-capture.

---

## 2026-07-11 — Fix: opencode container heartbeat + routing on error

Enabling the console exposed two pre-existing gaps: (1) the opencode container never sent heartbeats, so `agent_runtimes` drifted to `error/heartbeat_stale`; (2) `resolveAgentBaseUrl` only routed to the per-user container on `status='running'`, so an error status fell back to the global `OPENCODE_SERVER_URL` (a stopped shared agent) — breaking the user's triggers. Fixes: opencode entrypoint now runs a 60s heartbeat loop (`POST /me/agent/heartbeat`); `resolveAgentBaseUrl` routes to the per-user container for `running|provisioning|error` (a lagging heartbeat no longer misroutes), falling back to global only when the row is absent or `stopped`.

---

## 2026-07-11 — Per-user opencode web console (flag-gated, DECISION-026)

Built the per-user console: opencode's web UI at `agent-<uid>.<CONSOLE_DOMAIN_BASE>` (Traefik labels stamped by the orchestrator), gated by the tenant LL5 token via a `forwardAuth` handshake (`/me/agent/console/enter` mints a console token → cookie validated by `/internal/console-auth`). Dashboard "Open console" button (shown when running). **OFF until `CONSOLE_DOMAIN_BASE` is set** — gateway returns 503, orchestrator emits no labels. Also confirmed the tenant LL5 token already scopes 100% of MCP + tool calls (proxy injects it on every MCP request; every gw()/plugin call sends it). Follow-up: `OPENCODE_SERVER_PASSWORD` for internal defense-in-depth; verify Traefik picks up labels on the non-Coolify orchestrator containers before enabling.

---

## 2026-07-11 — Agent page: fuller runtime info

Runtime card now shows a details grid: provider, model, per-tool model overrides, container id (short), host, and last heartbeat — alongside status/actions and the Workers heartbeats. Purely additive.

---

## 2026-07-11 — Per-user agent-trigger routing (multi-tenant)

The gateway's opencode trigger URL was a single global `OPENCODE_SERVER_URL` — fine for one tenant, but a second tenant's triggers would hit the first tenant's container. Added `resolveAgentBaseUrl(pool, userId)`: a user with a **running** `agent_runtimes` row routes to their deterministic container `http://ll5-agent-<userId>:4096`; otherwise falls back to the global env (shared-agent compose, or a user without a per-user container). `triggerAgent` now takes an optional `baseUrl`; all 3 call sites (system-message, agent-trigger-listener, stuck-message-sweep) resolve + pass it. Claude-variant no-op behavior (empty env → null) preserved. +5 tests. This removes the dependency on the global env flip for routing — arnon now routes to his container via the runtime row regardless of the env value (env remains the fallback).

---

## 2026-07-10 — Fix: agent API key "disappears on refresh"

`ClaudeKeyForm` seeded its display state with `useState(status)`, latching the pre-fetch `{configured:false}` the parent passes before its async credential fetch resolves — so the badge showed "Not connected" after every refresh even though the key was stored (GET returned `configured:true`). "Save" only appeared to work because the save handler set local state directly. Added a `useEffect([status])` that re-seeds local/provider/model/overrides when the loaded status arrives. Pre-existing bug; surfaced during the agent-config work. (Diagnosed against prod: token correctly carries `uid = auth_users.user_id`; credential row + GET both fine — the defect was purely client render state.)

---

## 2026-07-10 — Agent settings page: 100% on the new (orchestrator) system

Cleaned `/settings/agent` so it configures + monitors ONLY the new per-user orchestrator system:
- **Removed** the old "Connection kit" section (mint token + `.mcp.json` for a self-run Claude Code on your own machine — the pre-orchestrator BYO path). No other consumer referenced it; the backend endpoints (`/me/agent/connection`, `/me/agent/credentials`) + their server actions/types remain for now (harmless, `formatMcpConfig` still unit-tested).
- **Kept + made provider-agnostic**: Model & API key (provider/model + per-tool models), Hosted runtime (provision/stop the orchestrator container), Workers (heartbeats of the workers inside your container). De-Claude'd all copy ("your Claude credential" → "your configured provider/model/key").
- Typecheck clean; agent-types tests unchanged/green.

---

## 2026-07-10 — Per-agent/per-tool model overrides (UI-configurable)

The tenant LLM config now supports **per-sub-agent model overrides** on top of the main model. A user can, for example, keep the cheap main model but run the grounder on a stronger one.
- **Schema** (042): `agent_llm_credentials.model_overrides JSONB DEFAULT '{}'` — map of `slot → model_id`.
- **Slots** (opencode-only, they're the sub-agents the runtime spawns): `grounder` → `OPENCODE_GROUNDER_MODEL`, `narrative` → `OPENCODE_NARRATIVE_MODEL`, `reconcile` → `OPENCODE_RECONCILE_MODEL`. Registry = `AGENT_MODEL_SLOTS` in gateway `agent.ts`; mirrored in orchestrator `secrets.ts` (`SLOT_ENV`).
- **Gateway**: `PUT /me/agent/llm-credential` accepts + validates `model_overrides` (unknown slots / empty values dropped; each value must be in the provider catalog). `GET /me/agent/models` now returns the `slots` list. New **keyless update** path: a PUT with no `api_key` on an existing credential retunes model/overrides/base_url only — the stored key is never re-pasted or re-written.
- **Orchestrator**: `loadCredential` reads `model_overrides`; `SecretsWriter` emits `OPENCODE_<SLOT>_MODEL` for each known slot.
- **opencode variant** (`ll5-run-opencode`): `narrative-loop.ts` / `reconcile-loop.ts` read their slot env and pass `model` at spawn; `auto-ground.ts` already read `OPENCODE_GROUNDER_MODEL`.
- **Dashboard** `(user)/settings/agent`: a "Per-tool models" section (opencode only) with a dropdown per slot ("Default (main model)" = inherit). Save works with an empty key field (config-only update).
- Tests: gateway +5, orchestrator +1, all green; typecheck clean across gateway/orchestrator/dashboard/variant.
- **Note on the Zen cap:** verified the local "opencode-go" key is the **same workspace** (`wrk_01KX…`) as the capped key — both 402 on `deepseek-v4-pro` with the $62 `MonthlyLimitError`. The go key does NOT unlock pro; only raising the workspace cap does. Still on `deepseek-v4-flash-free`.

---

## 2026-07-10 — Deploy the agent-orchestrator (per-user opencode containers)

Stood up the `agent-orchestrator` control plane so each user gets their own opencode container (its own LL5 token scoping every MCP call = per-user isolation). Closed the opencode-under-orchestrator gaps the code review surfaced (the orchestrator was built for the Claude base-image):
- **docker-runtime**: attach the ll5 stack network (`HostConfig.NetworkMode`, via `AGENT_NETWORK`) — without it the container lands on the default bridge and can't reach gateway/MCPs.
- **opencode entrypoint** (`ll5-run-opencode` 8cd35c1): source `LL5_AGENT_ENV_FILE` (it read env directly before, ignoring the orchestrator's bind-mounted 0600 secret file).
- **orchestrator secrets**: also emit `LL5_TOKEN` (opencode reads that; Claude base-image used `LL5_AGENT_TOKEN`).
- **compose**: `agent-orchestrator` service (docker.sock + host-coherent `/run/ll5` mount + `AGENT_NETWORK` + `AGENT_IMAGE_OPENCODE`); CI matrix + Dockerfile case; gateway `ORCHESTRATOR_URL` defaulted to the internal address; `ORCHESTRATOR_SECRET` injected in the deploy step.
- **SECURITY**: only this service mounts `/var/run/docker.sock` (root-equivalent). Per-user secrets are 0600 env-files bind-mounted read-only; never `-e`.
- Provision flow: store the user's opencode llm-credential (`/settings/agent`) → `POST /me/agent/provision` → orchestrator launches `ll5-agent-<userid>` on the stack network. Old shared agent stays up.

---

## 2026-07-10 — Tenant-level agent LLM config (provider/model/key) + user UI

Made the agent's LLM config **per-tenant** and user-configurable, extending the existing BYO-key provisioning scaffold (which was Claude-key-only):
- **Schema** (041): `agent_llm_credentials` gains `provider` (anthropic|opencode), `model`, `base_url`.
- **Orchestrator**: `loadCredential` reads the full row; the per-user 0600 env-file now writes provider-specific keys — opencode → `AGENT_VARIANT=opencode` + `OPENCODE_ZEN_API_KEY`/`OPENCODE_MODEL_ID`/`OPENCODE_PROVIDER_ID`/`OPENCODE_SERVER_URL`; anthropic → `ANTHROPIC_API_KEY`. Per-provider image via `imagesByProvider` (`AGENT_IMAGE_OPENCODE` env). 25 tests.
- **Gateway** `agent.ts`: `PUT/GET /me/agent/llm-credential` now carry `provider`/`model`/`base_url` with per-provider key + model-catalog validation; new `GET /me/agent/models`. 21 tests.
- **Dashboard** `(user)/settings/agent`: provider selector + model dropdown + provider-aware key form (fetches the catalog). 21 tests, typecheck clean.
- **Deployment note:** this wires the ORCHESTRATOR (per-user container) path. The current live deployment is still the single shared compose agent with global env; cutover to orchestrator-per-user is a separate operational step.

---

## 2026-07-10 — INCIDENT: Zen $62 spend cap → agent dark; switched to free tier

The opencode agent went fully dark ~12:36Z — 0-token workers, 0 journals/narratives/observations, no eval moments, all 3 liveness alerts firing. **Root cause = billing, not code:** the Zen workspace hit its `$62/month` spending limit → `deepseek-v4-pro` refused on every model call (`AI_APICallError: ... monthly spending limit of $62`). All the session's code fixes were correct and deployed; the agent simply couldn't call its model. Diagnose: `docker logs agent-xkkcc… | grep "spending limit"`.

**Stopgap:** switched the default model to `opencode/deepseek-v4-flash-free` (free tier, $0, unaffected by the paid cap) — `opencode.json` default + gateway `OPENCODE_MODEL_ID` var + CI/compose defaults. Deploys via the working pipeline. **Follow-up (requested):** make the opencode instance config (URLs, keys, model) tenant-level (tables `agent_runtimes` / `agent_llm_credentials` already exist) + a user-facing UI to set model + API key. See the next work item.

---

## 2026-07-10 — record_moment tool parity + Claude-vs-opencode tool matrix

- **record_moment (parity bug 2):** added the `record_moment` plugin tool to opencode (the shared CLAUDE.md Eval rule tells the agent to call it; opencode had none → no-op) + allowed it in the external-authority-gate + eval-recorder now ships `decision_claimed`/`decision_mismatch` (flags a hollow ping_later). Variant `fa91358`, 44/44 tests.
- **Tool parity matrix:** new `docs/claude-vs-opencode-tools.md` — full tool-for-tool comparison (MCP servers, channel tools, hooks↔plugins, workers). Key opencode gaps documented: no `vault`/`system` MCP, no `inspect_image` (vision), and 5 minor channel tools (get_message, get/set_user_settings, get_current_time, channel_health).
- **Tool-gap fix plan:** new `docs/implementation/impl-opencode-tool-gaps.md` — multi-agent approach (tool→agent→model). Tier 1 = 5 trivial plugin tools; Tier 2 = `inspect_image` via a dedicated `image-analyst` vision subagent (deepseek-v4-pro is text-only; the plugin spawns the subagent via SDK so the gate's `task` deny stays); Tier 3 = `vault`/`system` MCPs, main-agent-only. Blocking decision: source a vision model (verify Zen catalog, else add a provider).

---

## 2026-07-10 — Reconcile worker un-stalled + CI repository_dispatch deploy-only fix

**Reconcile worker outage:** The reconcile worker went silent (watchdog: "stopped calling list_reconcile_work", 141m > 90m) → open loops never closed (0 in the last hour). Root cause in `ll5-run-opencode/scripts/reconcile-loop.ts`: the single-flight guard keyed on `s.time?.compacting === undefined` — a field opencode never sets, so the predicate was ALWAYS true. Combined with opencode NOT dropping deleted sessions from `session.list()`, every finished `narrative-loop` session lingered and matched → reconcile deferred on every tick, permanently. The guard is also unnecessary (docker-entrypoint.sh runs the workers sequentially — no concurrency possible). Removed it (variant `09357b6`).

**CI bug my PAT fix exposed:** With `trigger-ll5-rebuild` now working, `repository_dispatch(rebuild-agent)` fired and ll5's CI tried to REBUILD the variant image, pushing to `ghcr.io/arnonzamir/ll5-run-opencode` → `403 Forbidden` (ll5's `GITHUB_TOKEN` can't push to the variant repo's GHCR package). Build failed → deploy skipped → the reconcile fix didn't land. Fix: on `repository_dispatch`, ll5 now builds nothing (the variant's own CI already pushed `:latest`) and runs **deploy-only** — empty build matrix; the `deploy` job now runs when `build` is skipped (guards on `needs.build.result != failure/cancelled`), pulling the variant's `:latest`. Follow-up: `detect-changes` must emit an EMPTY matrix string (not `{"package":[]}`) when nothing builds — a zero-entry matrix object made the build job fail ("matrix vector does not contain any values") → deploy skipped. The first deploy-only dispatch exposed it.

---

## 2026-07-10 — opencode P2/P3 parity gaps closed (probe 406, watchdog, telemetry)

The four remaining opencode-vs-Claude gaps are fixed (variant `c217d02`, naming corrected in `d5fe585`; gateway side here):

- **MCP probe 406 (P2):** `check_mcp_connectivity` now sends `Accept: application/json, text/event-stream` + full `initialize` params. The header-less probe was 406'd by the streamable-HTTP MCPs → false "down".
- **Probe failure notification (P3b):** probe raises a keyed `mcp.connectivity` warning alert when any MCP is unreachable and clears it on recovery. Required a gateway change: `POST /alerts` now accepts `{ key, resolved: true }` → `clearAlert(userId, key)`, so on-demand probes can raise-on-failure + clear-on-recovery idempotently.
- **Narration "Still on it" backstop (P3a):** narration-watchdog arms on chat.message and posts one short narration if >15s pass on a user-waiting turn with no user-facing message.
- **Tool telemetry (P3c):** new `tool-telemetry.ts` reports channel/plugin tool results to `POST /telemetry/tool-result` (MCP tools already log via the proxy).

Also verified + settled a naming question: **opencode names MCP tools `<server>_<tool>` with a SINGLE underscore** (not `__` like Claude Code) — confirmed from the live permission engine (`permission=awareness_write_journal`). `d5fe585` corrected every `__` reference in the variant (external-authority-gate allowlist, activity-marker, cron-block, opencode.json, agent `.md`s, memory-intercept). The double-underscore mismatch had silently DENIED `note_observation` on external turns since Jul 7 → no observations → `list_narrative_work` empty → 188 narratives untouched for 3 days.

---

## 2026-07-10 — Restored variant→ll5 auto-deploy (trigger-ll5-rebuild)

The variant repo's `trigger-ll5-rebuild` workflow had been failing (`Parameter token or opts.auth is required`) because the `LL5_DISPATCH_PAT` secret was never set on `arnonzamir/ll5-run-opencode` — so variant-only pushes did NOT auto-redeploy the ll5 stack (manual `docker compose pull agent` was the workaround). Created a classic PAT (`repo`, no expiry), set it as the `LL5_DISPATCH_PAT` secret, and verified: manual `workflow_dispatch` of the trigger succeeded and ll5 received the `repository_dispatch` (`rebuild-agent`, `package: run-opencode`) → auto build+deploy. Full chain restored: variant push → image build → dispatch → ll5 deploy. (ll5 already handled `repository_dispatch: types: [rebuild-agent]` — the PAT was the only missing piece.)

---

## 2026-07-10 — opencode model config: single default + provider-typo fix

**Root cause (main session ran wrong model):** The GitHub repo var `OPENCODE_PROVIDER_ID` was misspelled `opencede`. The gateway composes `model: { providerID, modelID }` into the opencode `prompt_async` body; with an unresolvable provider, opencode discarded the model spec and fell back to its free built-in (`minimax-m3`). `OPENCODE_MODEL_ID` itself was already `deepseek-v4-pro`.

**Secondary issue (config split-brain):** The model was pinned in 4+ disagreeing places — `opencode.json` (global + 4 per-agent), the 3 agent `.md` frontmatter (stale `deepseek-v4-flash-free`, which *overrides* `opencode.json`), and the frontmatter test (asserted the stale value, so CI stayed green on the wrong config). Workers ran flash-free while `opencode.json` claimed pro; nothing ran the intended model.

**Fix — one default, explicit override tiers:**
- **Global default** = `opencode.json` top-level `model`/`small_model` = `opencode/deepseek-v4-pro`. The only place the default lives.
- Removed the per-agent `model` from all 4 `opencode.json` `agent.*` entries and from the 3 `.opencode/agents/*.md` frontmatter → every agent inherits the global default.
- **Per-worker override** = add a `model:` line back to that agent's `.md` (or `opencode.json` `agent.<name>`). **Per main-session/case override** = gateway env `OPENCODE_MODEL_ID`/`OPENCODE_PROVIDER_ID`.
- Rewrote `agent-frontmatter.test.ts` to enforce inherit-by-default (frontmatter pins NO model) instead of locking a literal value.
- Fixed `OPENCODE_PROVIDER_ID` var `opencede`→`opencode`; changed CI (`build-and-push.yml` ×2) + `docker-compose.prod.yml` fallback defaults `minimax-m3`→`deepseek-v4-pro` so a missing var still resolves correctly.
- Variant test suite: 28/28 pass. Takes effect on next deploy (live container keeps old `.env` until redeployed).

---

## 2026-07-10 — Web/Android tool-block fix + watchdog false-positive fix

**Root cause:** The opencode variant's `agent-trigger-listener` (gateway) tagged ALL inbound messages with `source.platform`, including web/Android. The opencode `turn-context.ts` plugin then set `externally_triggered: true` for any platform, triggering the external-authority-gate (Hard Rule 13). This blocked ALL non-allowlisted tools on web/Android turns — the agent couldn't call `check_mcp_connectivity`, `create_tickler`, `create_wake`, or any state-changing tool from the dashboard. Only WhatsApp/Telegram should trigger Rule 13.

**Fixes (gateway repo):**
- `agent-trigger-listener.ts`: Only attach source metadata for external channels (whatsapp/telegram/slack/sms). Unified channels (web/android/cli) get no source → `turn-context` treats them as user-initiated → gate stays open.
- `anomaly-monitor.ts`: `loop.narrative_consolidation` threshold raised 45m→90m (same as `loop.reconcile_worker`). The opencode variant's worker cadence is ~60 min (sleep 3600s); the 45m threshold was designed for Claude Code's ~20-min cadence.

**Fixes (ll5-run-opencode repo):**
- `turn-context.ts`: Added `UNIFIED_CHANNELS = ['web','android','cli']` — these are user-initiated, `externally_triggered` is only set for contact/group platforms.
- `external-authority-gate.ts`: Fixed `check_mcp_connectivity` bypass — actual tool name has no `ll5channel__` prefix (plugin tools don't get server prefixes).
- `stop-mirror.ts`: Fixed gateway contract — was sending `{text, source}` instead of `{channel:'web', content, direction:'outbound', role:'assistant'}`. The stop-mirror has been silently failing since deployment, meaning the agent's fallback reply mechanism was broken. This is why web and Android showed different conversations — `push_to_user` worked but `stop-mirror` never fired as a fallback.

---

## Current Status

**opencode variant LIVE and working** (2026-07-09). Agent container running at `ghcr.io/arnonzamir/ll5-run-opencode:latest`. Agents responds to chat messages on web + Android + WhatsApp. Workers (reconcile, narrative, continuity-probe) run successfully. MCPs (6/6) connected and healthy. Container healthcheck: healthy. See `docs/opencode-variant-deployment.md` for full deployment history and procedure.

### opencode variant live (2026-07-09) — Phase 5 & 6 complete
The opencode agent runtime is fully operational on the production server. Detailed history, architecture, issues, and deployment procedure documented in `docs/opencode-variant-deployment.md`.

**Issues encountered and resolved (in order):**
1. CI workflow repo name mismatch → fixed
2. Wrong model name (anthropic default) → switched to `opencode/deepseek-v4-flash-free`
3. Session registration SQL type inference → `::text` casts
4. `@opencode-ai/sdk` not installed at workspace root → added `npm install` to Dockerfile
5. Stale workspace Docker volume shadowing new image content → removed from compose, deleted volume
6. `wget` hangs on keepalive HTTP connections in entrypoint → replaced with `curl --max-time`
7. Missing `channel`/`content`/`direction`/`role` fields in gateway POST calls → updated all tools
8. Correlation-id proxy crash on `ERR_HTTP_HEADERS_SENT` → `headersSent` guard in catch block
9. Healthcheck included proxy (optional service) causing false unhealthy → removed proxy from healthcheck
10. Worker agent `.md` frontmatter overrode model to `anthropic/claude-sonnet-4-20250514` — narrative-loop and reconcile-loop silently produced empty output → fixed to `opencode/deepseek-v4-flash-free`

**Anomaly monitor fix (2026-07-09):** `loop.reconcile_worker` threshold raised 45m→90m — the opencode variant's worker cadence is ~60min (3520s sleep between cycles), so 45m fired a false alarm on every first sleep gap. 90m catches a double-missed cycle. Also removed a stale `agent` container (15h old Claude variant orphan) on the server.

**Worker tracking UI (2026-07-09):** New `agent_session_heartbeats` JSONB column (migration 040), `GET /me/agent-sessions` endpoint returning agent_session_id, agent_sessions, and per-worker heartbeat timestamps. `POST /internal/agent-session` now records ISO timestamps on every registration call. Dashboard `WorkersCard` component (15s poll) shows 3 workers (Interactive, Narrative, Reconcile) with green/yellow/red live-status dots and last-seen age. Added to the Settings → Agent page.

**Known gaps vs Claude Code variant:** (see docs for full list). 7 of 11 gaps now fixed — see `docs/opencode-variant-deployment.md#known-gaps-vs-claude-code-variant`.

### Dual run-variant migration — Phases 0-5 complete (2026-07-09)
Restructured ll5 to support two interchangeable agent runtime variants (Claude Code + opencode). See `docs/implementation/dual-run-variant-plan.md` + `dual-run-MASTER-INDEX.md`.
- **Phase 0:** `ll5-run` renamed to `ll5-run-claude-code` on GitHub.
- **Phase 1:** Shared content (CLAUDE.md, 17 skills, prompts, mcp-endpoints.json) extracted to `packages/ll5-run-shared/`. `scripts/render-mcp-config.ts` renders MCP config for both variants. 21 files created.
- **Phase 2:** Gateway `agent-trigger.ts` (env-driven no-op/HTTP trigger), migration 039 (`agent_session_id` + `agent_sessions` JSONB), 7 new `/internal/*` endpoints (agent-session, ingest-memory, regrounding, activity, continuity-probe, memory-intercept-log, recall-lessons). `system-message.ts` + `stuck-message-sweep.ts` modified.
- **Phase 3:** `ll5-run-opencode` repo created (35 files: 18 plugins, 3 agent definitions, 7 SDK worker scripts, opencode.json, docker-entrypoint.sh, healthcheck.sh, CI workflow).
- **Phase 4:** `Dockerfile.ll5-run-claude` + `Dockerfile.ll5-run-opencode` created. `build-and-push.yml` extended. `docker-compose.prod.yml` agent service added.
- **Phase 5 (deploy opencode):** Image built and pushed, container running, all services healthy.
- **Phase 6 (switch and use):** Chat working end-to-end; agent responds; workers running.

### Phone-contact junk-name guard
Correction of an earlier same-day change. **What actually happened:** `processPhoneContacts` logged `warn`-level "value too long for type character varying(255)" lines when a phone address-book entry had a corrupt 2KB "name" (spam/fraud SMS text saved as a contact name). These were **non-fatal** — caught in try/catch, the webhook still returned `accepted:N, failed:0`; nothing was broken. An earlier hotfix mis-read this as an outage and widened `messaging_contacts.display_name` to TEXT, which is **worse** — it lets that junk *overwrite* real contacts' display names (the UPDATE enriches existing rows). **Correct fix (this change):** skip address-book entries whose name is > 200 chars in `processors/phone-contacts.ts` (`MAX_DISPLAY_NAME_LENGTH`) — no real name/group name is that long — so junk is dropped, not stored, and the column overflow can't happen. Reverted the live column back to VARCHAR(255), deleted the bogus migration 039 + its schema_migrations row. Gateway tests green.

### Pencil-the-timeline reflex + liveness governor (2026-07-07)
Persona (ll5-run) gained: (1) Rule 15 schedule-claim grounding now reads the FULL local day across ALL calendars (`list_events` no-filter unions every readable calendar incl. LL5 System, + `list_ticklers`), OOO/day-off is the FRAME not a footnote, and ground-the-day-before-penciling-a-time — from the tomorrow-planning review (agent answered "where will I be" off the WORK calendar 3×); (2) a capture reflex — every time-anchored thought/option/decision/expectation is penciled onto the LL5 System calendar the same turn via `create_tickler(kind:instruction)` (the only tool that reliably writes there; LL5 System is access_mode='read' so create_event can't). **Liveness governor** for that reflex: `eval_record.py` ships `pencil_count` (create_tickler+create_event occurrences/turn) → gateway `/telemetry/eval-moment` whitelist + `ll5_eval_moments` mapping → anomaly-monitor `behavior.pencil_reflex_stalled` (staleness on last `pencil_count>0` moment, 72h, self-arming via `range gt:0` so it never fires before the first pencil). Gateway 735 tests green, ll5-run eval_record green, tsc clean.

### Active context integration — DECISION-025 (design-complete 2026-07-07, implementation starting)
`docs/decisions/DECISION-025-active-context-integration.md` (accepted, v6) + `docs/requirements/BRD-active-context-integration.md`.
The agent's "understand → fulfill → verify" contract + active reconciliation of every signal against open loops.
Vetted by 8 review agents (2 triple-reviews + 2 confirmations). Key shape: reactive grounding = Rule 15 rewrite
(+ external-web claim class); active reconciliation = an **off-agent `claude -p` worker** on the narrative-loop
pattern with a **deterministic-coverage** control plane (LLM judges close/keep; coverage — not correctness — is
guaranteed; blind spot stated), a **locked-down** tool surface (read+close only — NOT the narrative worker's
bypassPermissions), **human-confirm on consequential closes** (deterministic `stakes`-stamp gate, fail-safe
`consequential`), `pgrep`-only coordination so the narrative loop is untouched, and a governor
(`missed_close`/`wrong_close`/`reconciliation_coverage`) on the eval spine. Phased rollout: D1 contract + D2
read-model first, then the worker + governor, then the close-gate; sandbox self-tooling (FR-8) gated on
DECISION-023 + the D7 egress amendment. Provisional FR-9 scope (a); 1-week checkpoint 2026-07-14.
**Build progress (local, tested, NOT pushed):** Phase 1a done — D1 Rule 15 rewrite + `WebFetch`/`WebSearch`
in `GROUNDING_TOOLS` (ll5-run, commit b1587ac; frozen-rule + eval tests green) and D2 `getOpenLoops`
read-model (gateway `open-loops.ts`, 3 tests). Phase-1b: D4 migration 003
(`conversation_id`/`stakes` DEFAULT consequential/`reviewed_at` on `gtd_horizons`) + `reconcile.ts`
`listReconcileWork` deterministic selector (6 tests; 666 gateway total). Phase-1c: `reconcile-gate.ts` — the deterministic close-gate (stakes-routing + atomic close + circuit-breaker; 8 tests). **The entire deterministic reconciliation spine is now built + tested locally** (read-model, selector, gate, migration). Remaining work + a fanout orchestration brief for a fresh session: docs/implementation/DECISION-025-continuation.md (Phase A: GTD MCP tools + stamping + confirm UX; B: governor/metrics; C: tests + gated deploy).
**Phase A progress (local, tested, NOT pushed):** A2 done — `create_action` now accepts + stamps `conversation_id` + `stakes` (enum `low|consequential`) at loop creation, threaded into the postgres `createAction` INSERT (dynamic columns, fully parametrized; `stakes` omitted ⇒ DB DEFAULT 'consequential' fail-safe; `conversation_id` omitted ⇒ NULL). Inbox-triage + shopping paths correctly fall through to NULL/default (they never create message-linked loops). GTD tests 103 green, tsc clean. A3 done — human-confirm UX: new gateway tray kind `reconcile_confirm` + `POST /me/reconcile/confirm` (closes a consequential loop ONLY via the gate's `confirmReconcileClose` — single writer, user-scoped; userId from token not body; UUID-validated; idempotent enqueue; fail-open pre-migration; migration 038 adds `tray_items.loop_id`). Gateway tests 685 green, tsc + build clean. A1 done — GTD MCP now exposes `list_reconcile_work` (deterministic selector, no args) + `reconcile_loop` (loop_id + action close|advance|keep_open, via the gate) as the off-agent worker's ONLY mutation surface; `tools/reconcile.ts` is a faithful port of the tested gateway selector+gate, with a read-only awareness ES client (only `.search`; null-degrades when ELASTICSEARCH_URL unset). Independently adversarially reviewed — tenant isolation / minimal surface / atomicity / best-effort / parity all HOLD; the review caught a latent **fail-open** in the stakes gate (auto-closed on anything `!== 'consequential'` rather than only `=== 'low'`) — **fixed in BOTH the GTD port and the gateway original** to fail SAFE (only `low` auto-closes; unexpected value → human-confirm) + a `CHECK (stakes IN ('low','consequential'))` (GTD migration 004) + a negative test locking it. GTD 131 tests green, gateway 686 green, tsc clean. **Phase A (make the worker runnable) is code-complete + tested locally; NOT deployed.**
**Phase B progress (local, tested, NOT pushed):** B1+B2 done — `scheduler/reconcile-governor.ts` (`ReconcileGovernorScheduler`, cheap 15-min per-user singleton, registered in scheduler/index.ts) computes the three D4/D6 metrics and writes one counts-only doc per cycle to `ll5_reconcile_metrics` (contract `ReconcileMetricsDoc`): `missed_close_count` (reuses `listReconcileWork`), `reconciliation_coverage` (grounded-candidates/candidates, `null` on 0), `wrong_close_count` (closed message-linked loops with zero grounding this cycle). Schema finding: grounding-by-conversation reads `ll5_audit_log` (kind=`tool_call`, `tool_name=query_im_messages`, JSON `args.conversation_id`) — NOT `ll5_app_log` (which lacks args/conversation_id). Counts/ids/timestamps only (F5, tested no-leak); user_id-scoped every query (cross-tenant test); best-effort never-throws. Gateway 695 tests green, tsc clean. Deploy-time TODO (Phase C): verify `ll5_audit_log` actually carries `query_im_messages` tool_call docs with `args.conversation_id` (else coverage silently reads 0). B3 done — anomaly-monitor gains: reconcile-loop liveness (`loop.reconcile_worker`, `toolCallAgeMinutes('list_reconcile_work')`), governor freshness (`loop.reconcile_governor`, `ll5_reconcile_metrics` staleness), three new `latestGauge` checks (`missed_close_count>0`, `wrong_close_count>0`, `reconciliation_coverage<0.8` gated on `candidate_count>=3`), and the narrative **non-degradation regression** (new `percentileRegression` kind — p95 inter-arrival gap AND p95 duration_ms of `list_narrative_work`, recent-180m vs baseline-24h, trips on ≥1.75× + absolute floor + ≥5 samples → catches a slow-but-alive loop, not just a dead one). All self-arm (null/absent/insufficient-data → no alert), so they stay silent until the subsystem is live; every query user_id-scoped (cross-tenant tests). Anomaly-monitor 30 tests (+14), gateway 709 green, tsc clean. B4 done — eval telemetry extended to loop CLOSES: new `close_count` field on the gateway `/telemetry/eval-moment` whitelist + `ll5_eval_moments` mapping (integer), and ll5-run `eval_record.py` counts loop-closes this turn (args-gated: `update_action` status=completed OR `reconcile_loop` action=close), shipped alongside `grounding_calls` — a close with `grounding_calls:0` is the ungrounded-close signal on the eval spine. Honest scope: the Stop-hook recorder sees only the LIVE agent's own closes; the off-agent worker's closes are covered separately by the governor's `wrong_close_count` (B1/B2). F5 verified on both sides — index-side (gateway) drops all free-text (message/body/text/payload) and coerces `message_sent`→bool (no body ever indexed); sender-side (ll5-run) ships only the lean whitelist. Gateway 713 tests green (new eval-moment-route.test.ts, 4), tsc clean; ll5-run eval_record tests green (+test_close_count, +test_ship_body_is_lean_whitelist). Pre-existing note for the checkpoint: `message_sent` still transmits delivered text over the wire (coerced to bool before indexing) — a wire/DLQ consideration, not an index leak. B5 done — `message-batch-review` now embeds a compact, CAPPED, read-only open-loops section (reuses `getOpenLoops`; waiting_fors ≤5 + next_actions ≤3 + projects ≤3 with "+N more" overflow) into the batch summary the agent wakes to, so it reconciles the inbound batch against what it's already waiting on (D2/D3). Best-effort (try/caught → section omitted, batch never broken/delayed), user-scoped. Gateway 719 tests green, tsc clean.
**Phase B (governor / observability) is COMPLETE + tested locally; NOT deployed.** **Phase C progress:** C1 §7 tests DONE (local, green) — (i) worker crash/atomicity no-drop + at-least-once-until-reviewed (gateway `reconcile-atomicity.test.ts`, 9); (ii) conversation_id-on-every-creation-path with a source-level tripwire guard that trips if a new horizon-0 INSERT is added unstamped (gtd `conversation-id-creation-paths.test.ts`, 9); (iii) worker seeded-injection golden — 10 attacker-fixture deterministic boundary replay (ll5-run `test_reconcile_injection_replay.py`); (iv) SC-2 Moti golden vs the WORKER prompt+MCP set (ll5-run `test_reconcile_sc2_golden.py`, 21). ll5-run goldens committed 3a41ab6. All CI-safe/no-model; the live-model injection + SC-2 replay is the one-time C3 deploy verification. gtd 140 / gateway 728 green, tsc clean. **C2 data-plane DEPLOYED + verified (2026-07-07):** pushed main → CI (build gtd+gateway) → Coolify, all green. Post-deploy verified on the box: gtd migration 004 (stakes CHECK) applied, all 4 migrations completed; gateway `ReconcileGovernor` + `AnomalyMonitor` started with the full new check list (loop.reconcile_worker/governor, missed/wrong-close, low_coverage, narrative cadence/cost regression); no governor write failures; gtd/gateway/awareness/knowledge health 200. **Config gap found + fixed in post-deploy verify:** the `gtd` service had NO `ELASTICSEARCH_URL` (it was PG-only pre-025), so `list_reconcile_work` null-degraded to empty → the worker would be a no-op. Added `ELASTICSEARCH_URL` to the gtd service in `docker/docker-compose.prod.yml` (lazy client, no ES depends_on so gtd stays up if ES is down); redeploy bounces gtd only. **C3 worker DEPLOYED (2026-07-07):** ll5-run — registered `reconcile-loop.sh` in `docker-entrypoint.sh` as a background sibling of the narrative loop (commit ll5-run 79bae5e), shipped the B4 `eval_record.py` (ba789c2) + the C1 goldens (3a41ab6). Deployed via `mcp__coolify__deploy js8owk0g0cgog800ckc8ww0s`. **Two deploy gotchas hit + fixed:** (1) ll5-run CI image lag — Coolify pulls a prebuilt GHCR `:latest`, so a redeploy raced ahead of CI and pulled the pre-fix image (fix: wait for the ll5-run CI build, then redeploy); (2) `reconcile-loop.sh` shipped mode 100644 — the entrypoint launches it directly (`/path/script &`, needs the execute bit), so it died silently with no log (narrative-loop.sh is 100755). Fixed with `chmod +x` (ll5-run 5a4ac2a). After the correct image: worker loop process alive (mode `-rwxr-xr-x`), logs its own "started" lines, narrative loop alive + unaffected (both under the entrypoint, pgrep one-way yield). **DECISION-025 Phase C (tests + gated deploy) essentially complete; full data-plane + worker LIVE.** **Human-confirm surfacing wired (2026-07-07, live-replay finding #2):** the replay showed a consequential `needs_confirm` was correctly advanced-not-closed (safety held) but NO tray confirm card was created — `enqueueReconcileConfirm` (A3) had no production caller. Wired via the domain-clean flag+governor pattern (user's choice): GTD `applyReconcile` sets `pending_confirm=true` on `gtd_horizons` (its OWN table, atomic with the reviewed stamp; migration 005 + index) on the needs_confirm path; the gateway `ReconcileGovernorScheduler.surfaceConfirmCards()` scans `pending_confirm=true` active loops and enqueues the reconcile_confirm card into `tray_items` (its OWN table, idempotent), then clears the flag — no cross-MCP write, at-least-once (a failed enqueue leaves the flag for retry). Mirror set in the gateway gate too. GTD 142 / gateway 734 green, tsc clean. **VERIFIED LIVE (2026-07-07):** seeded a consequential loop + resolving msg → worker returned "1 to-confirm" + DB showed `pending_confirm=true` (GTD half); the next gateway governor tick enqueued the tray card (`reconcile_confirm | open | Shall I close out "…"?`) and cleared the flag (`pending_confirm=false`) — full D5 human-confirm loop working end-to-end. All test data cleaned up (prod verified clean).
**Live seeded replay found a real production bug (2026-07-07):** `query_im_messages` filtered `{term:{conversation_id}}` on the ANALYZED text field — a real WhatsApp JID (`…@g.us`, 10219 docs) matches 0 there vs 10219 on `.keyword`. So the worker's grounding read (`query_im_messages({conversation_id})`) returned ZERO for every real thread → it saw candidates (selector uses `.keyword`) but read an empty thread → kept every loop open → **silent no-op in production**. Neither the deterministic goldens nor the C2 checks could catch this (no real ES thread read); the seeded live replay did. Fixed `packages/awareness/src/repositories/elasticsearch/message.repository.ts` to filter `conversation_id.keyword` (+ `message-query-conversation-id.test.ts`, 2 tests; awareness 212 green). This also fixes the LIVE agent reading specific threads by conversation_id. Deploying awareness.
Worker's FIRST LIVE TICK verified clean: `tick ok (23s, sess=6ad10bdc, $0.087): RECONCILED: 0 reviewed — nothing due` — full end-to-end smoke test (OAuth → locked-down `claude -p` → gtd MCP connect → `list_reconcile_work` → 0 candidates correct → clean tally), cheap/fast, no errors. Governor writing `ll5_reconcile_metrics` every cycle (8+ docs, counts-only, coverage null on 0 candidates). **DECISION-025 Phases A+B+C COMPLETE; data-plane + worker LIVE + verified.** Remaining (operational): optional seeded live injection/SC-2 replay (needs a synthetic test loop / prod write — deferred, not authorized); watch the governor + `missed_close_count` settle as real message-linked loops get stamped; the ≥5-day probe target + the **2026-07-14 FR-9 checkpoint** (re-evaluate the provisional option-(a) scope per DECISION-025's Review section).

### WhatsApp ingest via RabbitMQ + self-healing webhook (DECISION-024, 2026-07-06)
Response to a ~2h WhatsApp outage: Evolution had `webhookBase64:true` (re-applied on the Jul-4
re-pair) → media inlined base64 → gateway 413 (`express.json({limit:'1mb'})`) → Evolution retried
the poison payload 10× **serially**, head-of-line-blocking every text message behind it. The inlined
base64 was unused (gateway fetches media via `getBase64FromMediaMessage`). Fixes shipped:
**(1)** new `rabbitmq` service in the ll5 stack; the WhatsApp ingress now verifies+resolves then
**publishes to RabbitMQ and 200s immediately** (`utils/whatsapp-queue.ts`: exchange `whatsapp` →
`whatsapp.ingest`, `whatsapp.retry` TTL 15s, `whatsapp.dlq`; prefetch 20; publisher confirms; a
worker calls the shared `processors/whatsapp-dispatch.ts`). Broker down/unset ⇒ ingress processes
**inline** (no loss — never a hard dep). **(2)** self-healing webhook: `processors/whatsapp-webhook-config.ts`
`ensureWhatsAppWebhook` reconciles each instance's Evolution webhook to `base64:false` + secret +
full event list; triggered on `connection.update→open`/`application.startup` and by a periodic
scheduler (`scheduler/whatsapp-webhook-reconciler.ts`, 5min, Evolution GLOBAL key — closes the
cold-start gap). **(3)** connection lifecycle (`processors/whatsapp-lifecycle.ts`):
`connection.update`/`application.startup`/`logout.instance`/`qrcode.updated` update the account
`status`/`last_seen`/`last_error` + proactively engage the agent on down/up transitions. **(4)**
`WhatsAppFlowMonitor` cross-channel early trigger: alerts when WhatsApp silent >45m while another
channel was seen <20m ago (was flat 2h). New env: `RABBITMQ_URL`, `EVOLUTION_API_URL`,
`EVOLUTION_API_KEY` (global), `WHATSAPP_WEBHOOK_PUBLIC_URL`. +5 gateway tests (650 total).
**Verified on deploy:** broker healthy, gateway consumer connected, reconnect-backoff proven.
**Reconciler caveat + real fix:** the gateway reaches Evolution only via the public URL, which
404s the webhook-admin API (`/webhook/find|set`) — so the gateway reconciler is a no-op safety net.
Enforcement moved to the domain owner: `messaging/clients/evolution.client.ts` `createInstance` now
sets `webhook.base64:false` + lifecycle events at `/instance/create` (publicly reachable). Since a
re-pair = logout(delete)+reconnect(create), this is the path that must not revert to base64:true —
and now can't (+1 messaging test).
**Dedicated in-stack Evolution (evening):** diagnosing the dead dashboard buttons found the number
was linked across TWO Evolutions (ll4's public `evolution.noninoni.click`=as4wows + ll5's internal
wa-search i0okcoo) → 3-4 device links on one number = the real cause of the flapping/decrypt
failures; and messaging's `EVOLUTION_API_URL` pointed at ll4's Evolution (no ll5 instance → all
dashboard buttons 404). Fix: NEW `evolution` service in the ll5 stack (`evoapicloud/evolution-api:v2.3.7`,
`evolution` DB on ll5 pg, local cache), reached INTERNALLY at `http://evolution:8080` by messaging +
gateway (dashboard works, reconciler works, no public URL). Fresh `ll5` instance provisioned here
(base64:false); old ghost deleted. New env `EVOLUTION_GLOBAL_KEY` (GH secret).
**Live-verified 2026-07-06:** re-paired via dashboard Re-pair (now works — messaging reaches
`http://evolution:8080`); instance open, messages flow Evolution→gateway→`whatsapp.ingest`→worker→ES.
Two lifecycle fixes from the live run: (1) status-UPDATE `$3::text` cast (was throwing "inconsistent
types deduced"); (2) paging narrowed to `logged_out` only — `qr`/`close`/`connecting` no longer page
(a live re-pair falsely fired "waiting for QR"); WhatsAppFlowMonitor owns real outage detection.
**RabbitMQ monitoring UI:** gateway `GET /admin/rabbitmq` (`rabbitmq-stats.ts`, queries the broker
management API :15672) → per-queue depth/consumers/rates + non-destructive DLQ peek; dashboard admin
`QueueMonitor` panel (`(admin)/admin/queue-monitor.tsx` + `rabbitmq-actions.ts`) on the System Health
page, 15s poll, flags broker-down / DLQ>0 / no-consumer. **Tenant-scoping audit (DECISION-024):** the
WhatsApp integration is correctly tenant-scoped on all runtime paths (attribution is server-side from
instance→user, never the payload). Fixed GAP 1: added `UNIQUE(instance_name)` (messaging migration 006)
+ `create_whatsapp_account` now returns `INSTANCE_NAME_TAKEN` on 23505 — makes the instance→user
mapping the whole pipeline trusts authoritative at the DB (was assumed, not enforced).
**Independent review fixes (DECISION-024 Addendum 3):** biggest — reprocessing was NOT idempotent
(random ES doc id → retry duplicated message/media/agent-ping); fixed with a stable id from
`userId+key.id` + early `es.exists` skip. Also: `/webhook/whatsapp` parses at 10MB (a big non-media
event 413s before the queue → residual HOL); 406 topology-conflict now logs LOUD (was silent inline
fallback); consumer-channel rejections caught; reconnect timer cleared on close; migration 006 pre-cleans
dupes. +`whatsapp-queue.test.ts` (retry→DLQ/max-attempts/undecodable/publish-fallback) + idempotency test
(657 gateway tests). Review confirmed the rest sound: publisher-confirms-before-200, inline fallback,
admin-gated PII-free DLQ peek, tenant scoping.

### Vault multi-tenancy + agent-driven self-service provisioning (DECISION-022 addendum, 2026-07-04)
The vault is now TENANT-SCOPED with an agent-driven onboarding lifecycle (was single-tenant,
operator-provisioned — violated principle #3). **Model:** one Vaultwarden org per tenant
(`LL5 <first-8-of-userId>`, one `agent` collection each); the machine account creates and Owns
every tenant org (one bw sidecar serves all); isolation comes from the **userId→org mapping** in
gateway PG (`vault_tenants`, migration 035 — seeds the pre-tenancy admin org f08f46b3→3ef6bab6 so
today's setup keeps working). The vault MCP resolves the caller's org via GET `/vault/tenant`
before EVERY bw query, REFUSES when unmapped ("vault not provisioned"), passes
`organizationId`+`collectionId` filters on every bw list call, and asserts each returned item's
org id — cross-tenant reads impossible by construction (`bw/client.ts`). Mapping writes
(PUT `/vault/tenant`) need a `service`-role token only AUTH_SECRET holders can mint, so an agent
can never remap itself onto another tenant's org. **Lifecycle = agent tools** (self-scoped, no
credential material): `provision_vault({user_email})` (idempotent org+collection+Owner-invite
email — SMTP is live), `confirm_vault_membership()` (owner-confirm after the user accepts),
`vault_status()`. bootstrap.ts's client-side Bitwarden crypto became the `src/provision.ts`
library (TenantProvisioner; needs new env BW_EMAIL + existing BW_PASSWORD — unset ⇒ provisioning
disabled, logins unaffected); `src/tenancy.ts` is the one service behind the tools AND the vault
MCP's internal routes (`src/admin.ts`: POST `/internal/tenant/provision|confirm`,
GET `/internal/tenant/status` — token-authed, NOT MCP tools). **Gateway /me/vault/*** (chatAuth,
dashboard's future contract; no UI page yet): POST `/me/vault/provision` (uses auth_users email,
body override), POST `/me/vault/confirm`, GET `/me/vault/status` →
`{status, org_id, sites_count, approved_sites}` — thin proxies over the internal routes
(VAULT_MCP_URL, default http://vault:3000). Site approval stays user-authority (unchanged).
Persona: vault section rewritten as an agent-led onboarding walkthrough (never ask for any
password in chat, incl. the master password). Tests: vault 59 (tenant refusal when unmapped,
org-mismatch/scoping assertions, provision idempotency at tool+service layers, internal-route
auth), gateway 510 (59 files: /me/vault/* auth+shapes, service-role gate on PUT /vault/tenant,
migration seed assertions); both tsc clean. NOT deployed (BW_EMAIL secret + deploy pending).

### Credential vault + server-side browser login (DECISION-022, 2026-07-04)
NEW `packages/vault` MCP (`mcp-vault.noninoni.click`, `docker/Dockerfile.vault` = MCP base on
node:20-slim + `@bitwarden/cli`): runs `bw serve` as a localhost sidecar (config → login --apikey →
serve → POST /unlock; supervised restart on crash), scoped to the Vaultwarden org `LL5` / collection
`agent`. Tools: `list_login_sites` (names+bound domains ONLY), `browser_login({site})` (server-side
fill — the agent NEVER sees a secret), `login_status`. Two hard rules enforced in code:
**domain binding** (tldts eTLD+1 of the LIVE page re-checked immediately before every fill vs the
vault item's URL; item URL only, never caller input) and **approved-sites allowlist** (fails closed;
unapproved → `approval_required` + gateway approval request). Redaction discipline: sanitized errors,
`assertNoSecrets` on every tool result, name-only logs. **Browser container** switched to shared-CDP
mode: entrypoint launches Chromium itself (`--remote-debugging-port=9222`, internal-only, supervise
loop, same profile mount) and Playwright MCP attaches via `--cdp-endpoint` — DECISION-010 basicAuth/
allowed-hosts/blocked-origins unchanged; vault fills land in the SAME live session the agent browses.
**Gateway**: `src/vault.ts` — GET/PUT `/vault/approved-sites` (user_settings.vault.approved_sites,
chatAuth = same authority model as approvals.ts) + POST `/vault/approval-request` → raiseAlert
(warning, `vault.approval.<domain>`, push + [ALERT]); PUT auto-clears matching alerts. CI: `vault` in
the build matrix + deploy pull loop; BW_* GitHub secrets injected into the on-host .env by the deploy
job. Operator bootstrap: `packages/vault/scripts/bootstrap.ts` (Bitwarden client-side KDF register →
org/collection create → user invite → prints BW_CLIENTID/BW_CLIENTSECRET). Persona (ll5-run/CLAUDE.md):
vault-login flow section (never ask for passwords in chat; approval_required → tell user and wait;
payments/banking stay human). Tests: vault 27 (domain binding, allowlist gate incl. fail-closed,
redaction), gateway 492 (58 files, +11 vault routes), both tsc clean. NOT yet deployed: needs
bootstrap run + BW_* secrets + agent `.mcp.json` vault entry.

### Android: read-mostly Actions + Projects views (close the post-triage visibility gap, 2026-07-05)
User approved "Option A" — after inbox triage, kept (undated) actions and projects were invisible on the
phone (only Lists→Today's-actions showed dated-for-today items; projects nowhere). Gateway (gtd-surfaces.ts):
GET /me/actions?scope=active|today[&project_id=] → {actions:[{id,title,context,due_date,project_id,
project_title}]} (LEFT JOIN parent horizon-1 for project_title; scope=active uncapped-date LIMIT 200;
project_id ownership-checked→404) + GET /me/projects → {projects:[{id,title,status,action_count,
done_count}]} (single grouped count query, no N+1). /me/actions/today + complete/defer untouched. 645
tests. Android: Lists segments now Shopping | Actions | Projects. Actions pane = Today/All toggle,
GROUPED by project header (null-project bucket last), rows check→complete/swipe→defer + due badge
(overdue amber). Projects pane = title + "N active · M done" → tap → ProjectActionsScreen (that project's
actions, read-only + check/defer). Stays a VIEWPORT (no add/edit/reorder; Discuss→ into chat).
assembleDebug green.

### Web chat cleanup: fold record_moment/instrumentation rows (parity, 2026-07-05)
User picked "Chat cleanup" for web parity. Both dashboard chat surfaces now fold instrumentation rows
(record_moment / ToolSearch / bracket-tagged tool rows) into the collapsible "N system events" band even
when the backend didn't flag display_compact, AND a LONE instrumentation row folds into a "1 system
event" band instead of rendering standalone (same gap the app had). New isInstrumentationRow in
lib/chat/format.ts (full-screen /chat via buildRenderItems + CompactGroup) + a local twin in
chat-widget.tsx (tile); the tile's isWaiting/thinking-indicator now also skips instrumentation rows so a
record_moment no longer counts as "the answer arrived". tsc clean.

### Web dashboard: reaction picker → 👍/👎 only (parity with app, 2026-07-05)
Same overlapping-reaction fix as Android, now on the dashboard: both chat surfaces (chat-widget.tsx tile
+ chat/message-bubble.tsx full-screen) narrowed their PICKER to agree/disagree; REACTION_ICONS/LABELS +
VALID_REACTIONS kept full so existing/agent-sent reactions still render+validate (new PICKER_REACTIONS
in lib/chat/constants.ts). More web/app parity items pending user scoping.

### Fix: Google OAuth state DB-backed + triage hold-mode reliability (2026-07-05)
Google reconnect from CHAT failed "invalid or expired state token" — OAuth state was an in-memory Map
(10-min setTimeout), wiped by any google-service restart or a delayed chat-link click (dashboard worked
only because it opens consent instantly). Fix (packages/google): migration 005 google_oauth_states,
DB-backed 60-min single-use store (putState/takeState atomic DELETE-RETURNING/sweepExpired), both call
sites + callback rewired; 45 tests. ll5-run persona: fresh link each reconnect + declare ~1h validity +
regenerate if expired. Verified Google reconnected (live events read, 0 invalid_grant post). Also fixed
(Android): triage HOLD → hotspot mode was nearly unreachable — the hold/flick race used the ~8dp system
touch slop, so held-finger jitter always misclassified as flick; now classify by decisive early travel
(>28dp fast = flick, else long-press timeout → hotspot). assembleDebug green.

### Android triage expanded to 7 verbs + hotspot drag + map tile selector (2026-07-05)
Triage gained 3 verbs (frozen contract keep|trash|someday|done|reference|project|followup). Gateway
gtd-surfaces.ts: `reference` = instant, inbox processed/outcome_type reference + `[Inbox → Reference]`
agent msg (file in knowledge, no action created); `project`/`followup` = DEFERRED (inbox status→reviewed,
notes marker, NO synchronous create) + `[Inbox → Project]`/`[Inbox → Follow-up]` agent msgs instructing
it to propose via add_tray_item (existing-project-vs-new + title/def for project; next-action-vs-waiting-
for-+who for followup) → the user approves as a TRAY DECISION CARD, or chat if too complex; agent then
finishes the inbox item. 635 gateway tests. ll5-run: 3 dispatch entries + add_tray_item description note.
Android: hold-a-card → hotspot mode (55% scrim, 7 labeled drop-targets: 4 primaries at edges reinforcing
the flicks, reference/project/followup at corners; nearest-within-100dp highlights, release commits;
quick-flick still works for the 4 via awaitEachGesture racing longPress-vs-touchSlop); deferred actions
show "LL5 will sort this out →"; intro overlay v2 (triage_intro_v2_seen). Map: user-selectable tile
style (Voyager default / Dark / Light-Positron) via a Layers button, persisted (map_tile_style),
live-swapped without losing camera. assembleDebug green.

### Android Phase 4 polish — OSM map + triage freshness/legend (2026-07-05)
Map switched Google Maps Compose → **osmdroid + CARTO dark raster tiles** (keyless; matches the
dashboard's OSM choice; all Google plumbing/key-gating removed; attribution + User-Agent set). Inbox
triage: card age first-class ("captured Apr 13 · 3 months ago", relative-age tinted warning #D9A05B
past 30 days), persistent monospace gesture legend (→keep ←trash ↑someday ↓done, active dir lifts to
onSurface), one-time intro overlay (DataStore triage_intro_seen). BUG fixed at integration: InboxItemDto
mapped captured_at but the gateway serves created_at — the age would have been permanently null.
assembleDebug green.

### Android Phase 4 SHIPPED — topics rank, lists, triage, decision cards, map (2026-07-05)
Gateway: /narratives?sort=now (gateway re-rank: 0.35 open_loop [open_threads] + 0.30 calendar proximity
[≤48h token match vs calendar_events, closeness-scaled] + 0.25 recency [3d half-life] + 0.10 status;
VOLUME DROPPED; why_now {kind: open_loop|calendar|null, detail} — open_loop wins); NEW gtd-surfaces.ts
(GET /me/inbox limit10+remaining; POST triage keep|trash|someday|done mirroring process_inbox_item —
keep/done create the horizon-0 action, done pre-completed; POST triage-summary → ONE [Inbox Triage] msg,
kept = ACTION ids; shopping GET/add/check [store=category, uncheck reopens]; actions today ≤7/complete
[idempotent]/defer [tomorrow + note + agent msg]); NEW map.ts GET /me/map (devices latest-per, places
w/ coords, today trail suspect-excluded ≤200 downsampled). Decision cards: migration 037 tray_items +
POST /tray-items (agent, strict validation) + tray kind:decision projection + POST /me/tray/decision
(race-guarded vs expiry) + TrayItemExpiry scheduler (10min; expired → default applied WITH disclosure
msg). 631 gateway tests. ll5-run: add_tray_item channel tool; review skill solo mode files ≤3 decisions
as tray cards (Thu expiry default); persona: "a decision that needs the user goes on the tray, not into
the scroll"; [Decision] dispatch entry (apply choice/default NOW). Android: Topics rail (cap 5, ONE
why-now signal/row — Canvas open-loop arc or mono calendar chip; All topics → old list); Lists screen
(shopping w/ optimistic checks + per-store add; today's-actions viewport ≤7 check/defer only + Discuss→;
triage entry); inbox swipe triage (physical gestures RTL-safe, 104dp threshold, glyph hints, 10-cap end
card, batch summary w/ action_ids survives VM pop); tray decision cards (FlowRow A/B/C, recommended
filled); Map on maps-compose KEY-GATED (blank key → calm note, SDK never inits; dark style JSON;
initialed device dots + seen/stale provenance; trail toggle off-default; OSM/osmdroid swap OFFERED to
user — pending choice). USER-FEEDBACK ADDITIONS: record_moment/ToolSearch rows fold into chat activity
bands + expanded rows show one-line args summary (decision/category/gist); Today long-press → contextual
react sheet (event: Canceled/Not mine/Needs prep; voice: Spot on/Off the mark; habit: Pause) sending
bracketed-context chat msgs via existing send path + "Say more →" prefilled chat draft. assembleDebug
green. Map DTO trail_today mismatch caught+fixed at integration.

### Android Phase 2 SHIPPED — Today card + agent voice + widget (2026-07-05)
Gateway: migration 036 day_cards; POST /today-card (agent writes voice ≤400 + one_thing ≤200,
full-replace, today in effective tz); GET /me/today (voice/one_thing/next_event [ES calendar, excludes
instruction ticklers AND all_day docs, as_of provenance]/habit 14-day dot states [never invents missed
— the sweep owns that; today-unlogged=open]/needs_you_count via the SHARED tray collectors [badge and
count can't disagree]/quiet_since v1 proxy). tray.ts refactored to collectTrayItems/countTrayItems.
551 tests. ll5-run: NEW channel tool set_today_card (POST /today-card, telemetry-covered); daily +
evening-close skills end by updating the card; persona: "Today card is the phone's ambient anchor —
keep it current; a thoughtful person holding the user's day, not a task app." Android: Today screen per
§5a (voice above mechanics, LL5Mono times, provenance-when-stale, shared HabitDots component with
accent today-ring, quiet-state lead, doors as Phase-4 placeholders); Glance widget (one_thing over
today's habit dots, SharedPrefs snapshot render — no network in render, 30-min periodic + on-resume
worker, tap→Today); TodayRepository refreshes on resume + tray-count change + 15-min tick.
assembleDebug green. First real tray answer landed 08:52 (user tapped Done — log_habit_outcome via
phone, escalation silenced pre-09:00).

### Android Phase 1 SHIPPED — foundation + Needs You tray (2026-07-05)
User approved (decisions 2-6 + IA + demo). Gateway: NEW src/tray.ts — GET /me/tray aggregates habit
occurrences (open log rows OR due-but-rowless, per-habit tz; escalation.future_text computed from the
habit's OWN escalation config: "escalates to <level> <HH:MM> · your rule" / "auto-logs missed at
midnight"), pending contact approvals (shared listPendingApprovals helper), vault.approval.* firing
alerts; POST /me/habits/outcome (byte-identical upsert to gtd log_habit_outcome, rejects outcome=missed
— midnight sweep owns that; ownership-validated); POST /me/vault/approve-site (shared
writeApprovedSites + clearAlert; deny = clear + agent notice, no persistent block). 534 gateway tests.
Android (ll5-android): theme retokenized to the spec palette (dynamicColor REMOVED, dark forced,
LL5Mono style, extended success/warning colors), 4-tab nav Today(start)/Needs You/Chat/Topics +
LL5NavItem with NO badge slot (only NeedsYouNavItem badges; absent at 0), System screen (Status/Data/
Sensors/Settings/Approvals history) behind Today's gear, NEW ui/tray/ NeedsYouScreen (card anatomy per
spec §3 + approved demo: in-place Skip→Deliberate|Excused morph, 150ms fade-collapse, inline errors
only, "quiet since HH:MM" empty state, resume+60s refresh), TrayRepository StateFlows feed badge +
Today row, contact-approval Approve keeps the EXACT BiometricGate flow, FCM "approvals" deep link →
tray. CriticalAlertService/wifi/workers untouched. assembleDebug green.

### Android companion UI — deep review complete, user decisions in (2026-07-05)
Three-pass design review (codebase inventory / interaction model with productivity+psychology lenses /
concrete UI spec) synthesized in docs/design/android-companion-ui.md (+ -interaction-model.md, -spec.md).
Core: 4 attention tiers (Interrupt/Needs-You/Ambient/Archive); NEW Needs You tray = the app's ONLY badge,
one-tap answers as direct MCP writes (habit Done → log_habit_outcome — closes the dose-taken-unlogged
gap) + escalation-honesty lines; Today card + Glance widget (delivers DECISION-018 Phase 5); CC-feel
no-bubble chat (Markwon→Compose markdown is the prereq); topics rank v1 = 0.35 open-loop + 0.30 calendar
proximity + 0.25 recency + 0 volume, cap 5; GTD on mobile = capture/swipe-triage/decide ONLY; Google Maps
Compose; dark-first single-accent palette, Material You dropped. 4-phase build (tray first). 6 decisions
listed for the user in §5 of the synthesis doc. NO implementation started.

### Incident: WhatsApp 10h outage — device link culled, wrong-instance re-pair, recovered (2026-07-04)
Fri ~22:00 → Sat ~13:10. WhatsApp removed LL5's linked device (`device_removed` conflict) → Evolution
DELETED the logged-out `ll5` instance → LL5 ingestion dead. Morning misstep: re-paired the only visible
instance (`was_7536a4eeda67` — the wa-search ARCHIVE's link, not LL5's); a brief 08:10-08:24 burst from
the dying ll5 session masked the miss; WhatsApp hard-killed LL5's link 09:50 (possibly BECAUSE the new
pairing bumped it). Real fix: recreated instance `ll5` (global AUTHENTICATION_API_KEY; webhook →
gateway /webhook/whatsapp + secret), QR re-pair via self-refreshing Preview on the Mac, re-encrypted
the NEW per-instance apikey into messaging_whatsapp_accounts.api_key + instance_id (stale key made the
status poller flap the row to disconnected). Verified END-TO-END on webhook hits (user test message →
gateway → thread), status stable `connected`, channel.whatsapp resolved. Alert spine + agent behaved
well throughout (agent's 09:50 heads-up + fallback to recall during blindness). Full topology + 6 traps
recorded in HANDOFF ("WhatsApp topology + re-pair traps"). The throughput warning self-resolves as the
2h window refills.

### Wifi scan fingerprinting — see ALL visible networks, map them to places (DECISION-021, 2026-07-03)
The agent now sees every wifi network around the phone, not just the connected one, and visible-network
sets resolve to places. **Android (ll5-android):** new WifiScanRepository reads OS-cached
getScanResults() (no startScan — no throttle/battery cost), top 12 by RSSI, pushed as new webhook item
`wifi_scan` on the existing cycles (PushSyncWorker 15-min + heartbeat hourly), gated ≥5 min between
pushes + skip-if-BSSID-set-unchanged (resend after 30 min); Room offline queue (schema v7,
pending_wifi_scans); REMOVED `neverForLocation` from NEARBY_WIFI_DEVICES (it was present and strips
scan data!). BSSIDs lowercased. assembleDebug green. **Backend:** new ES index
`ll5_awareness_wifi_scans` (nested networks); gateway `processors/wifi-scan.ts` stores + AUTO-LEARNS
`visible` bindings into known_networks when the location state confirms a known place within ±10 min
(rssi ≥ −75, cap 10 visible bindings/place, same key-mutex + observation-cap as connected auto-learn;
`binding: connected|visible` field, legacy defaults connected). **Shared resolver** gains a
visible-fingerprint tier (4b, below connected-wifi anchor): confident visible bindings vote by place —
≥2 BSSIDs same place or 1 at rssi ≥ −65 → medium-confidence `source: wifi_scan` anchor when GPS is
absent/stale/coarse; corroborates (boost) when GPS agrees; fresh accurate disagreeing GPS wins
(drive-past intact). Wired on BOTH the awareness read path (LocationService) and gateway write path
(processors/location.ts) per DECISION-009 symmetry. **where_is_user** gains `wifi.visible`
{scan_age_s, total_visible, known:[{place,ssid,rssi}]} (≤10 min else omitted); get_situation inherits.
Contract gotcha handled: Android's Moshi OMITS null keys — gateway schema defaults missing ssid/
connected_bssid to null. Tests: shared 117 / gateway 481 / knowledge 104 / awareness 210, all tsc clean.
Deploy = gateway+awareness+knowledge together (mappings auto-ensured on boot; gateway also PUT-adds
`binding` to the live knowledge mapping). Android = local assembleDebug APK, manual install (no CI).

### StuckMessageSweep: re-notify lost deliveries instead of masking them + weekly review → Friday (2026-07-03)
The lost-NOTIFY known issue (below) is fixed at the sweep: `stuck-message-sweep.ts` is now TWO passes.
Pass A: system rows still `pending` after `stuck_message_renotify_minutes` (3) were never picked up (their
insert NOTIFY died in an SSE-reconnect window) — the sweep re-emits the SAME `new_message` pg_notify the
insert trigger sends (migration-018 payload shape), up to `stuck_message_max_renotifies` (3) attempts
tracked in `metadata.re_notify_count` (metadata-only UPDATE doesn't re-fire the trigger — the explicit
pg_notify is the only signal; `processing` rows are never re-notified, the channel had them). Pass B:
`processing` rows >30min flip as before (handled-but-unflipped); `pending` rows flip ONLY after
re-notifies are exhausted, with an error-level log naming the ids — a real delivery loss is now loud,
never silently "delivered". +5 tests (467 gateway). Also: weekly review moved to its documented slot —
`user_settings.scheduler.weekly_review_day` 4→5 (0=Sunday, so 5=Friday; the code fires by
Intl weekday in the effective tz). NOTE the review had been firing THURSDAYS all along (docs said Friday);
2026-07-03's review was fired manually to live-verify the new session+solo-fallback contract (opened with
calendar block + first concrete inbox question at 14:08; fallback wake fired 14:52 sharp; solo one-pager
14:53; user replied "agree" → agent executed the safe archives/trash/someday immediately). First natural
Friday fire: 2026-07-10 14:00.

### Companion program — live verification complete (2026-07-02 evening)
End-to-end verified in production: **HabitScheduler** (test habit fired at its exact minute; the live
agent handled the [Habit Check] correctly — logged `done` silently; eval moment recorded
suppress/suppress with grounding_calls=1, i.e. the recorder fix works — the old recorder would have
scored that turn a phantom ping_now). **Evening close** fired with a real self-carried collection
(1 staged + 20 open journal + 1 habit, 12 overflow) and the agent DELIVERED the close (tonight's
timeline, ≤3 loose ends, Ritalin line) — then self-grounded the "(no title) 19:00" event by reading the
calendar (recurring personal-time block) and updated the plan unprompted: Hard Rule 15 in live behavior.
**Ritalin migration:** `Ritalin 40mg AM` habit (id 37d6f9b6…, 5 escalation steps 07:20→09:25) ACTIVE in
parallel with the legacy `ritalin-escalation` wakes; one-off eval wake (source `habit-migration-eval`)
fires Jul 5 09:30 to check 3 days of habit_trends and cut over (PM/late-PM stay dynamic one-off chains —
their times depend on the actual AM dose; the eval wake asks for a recommendation). **Visibility agg**
verified live post-hotfix (2,352 from_me docs/30d bucket correctly). **KNOWN ISSUE (new, real):** system
messages inserted while the channel SSE is reconnecting (e.g. during gateway restarts) lose their PG
NOTIFY and sit `pending`; tonight's [Evening Close] + 16 burst rows were lost this way (recovered via a
manual re-nudge; agent processed immediately). Worse, **StuckMessageSweep flips such rows to `delivered`
after 30 min, silently MASKING the loss** (same class as the 2026-06-23 freshness-nudge loss). Follow-up
needed: sweep should distinguish handled-but-unflipped from never-delivered (e.g. require agent activity
after the row's insert, or re-notify instead of flipping beat/nudge rows). Evening-close knobs restored
to default 20:30 after the knob-override live test; dev verification habit retired.

### Hotfix: visibility agg broke query_im_messages — aggregate on conversation_id.keyword (2026-07-02)
Caught live by the ToolFailureMonitor ~10 min post-deploy (4/5 calls failing,
search_phase_execution_exception): the new getConversationVisibility filtered+aggregated on
`conversation_id`, which is mapped text (+`.keyword` subfield) in ll5_awareness_messages — fielddata
disabled → every query_im_messages call threw. Fix: terms filter + terms agg on
`conversation_id.keyword`; also fixed the same latent bug in `countActiveConversations` (cardinality on
the text field — called by get_situation, likely silently degraded). Tests updated (204 green).
Lesson: aggregations on dynamically/text-mapped ES fields need the .keyword subfield — check the LIVE
mapping, not the assumed one.

### Companion-usability program SHIPPED — Phases 0-4 built (2026-07-02)
All of DECISION-018/019/020 implemented in one release across ll5 + ll5-run (Phase 5 Today-card stays
gated on two weeks of beat data per the plan). **Gateway:** NEW `scheduler/evening-close.ts`
(EveningCloseScheduler — 20:30 local via effective tz, 60-min catch-up window, in-memory + durable
already-sent dedup [queries chat_messages for a today `[Evening Close]` row]; SELF-CARRYING nudge embeds
(a) today's non-compact unengaged assistant messages, (b) open journal entries, (c) gtd_habit_log
outcomes [42P01-defensive pre-migration]; caps 10 + overflow note; knobs evening_close_enabled/_hour/
_minute). NOTE: notification level is NOT persisted on chat_messages (only drives FCM) — staged
detection = unengaged fallback, documented in code. NEW `scheduler/habit-scheduler.ts` (HabitScheduler —
60s tick, per-habit tz else effective, DST-safe wall-clock, 90-min catch-up cap, durable step dedup via
steps_fired jsonb upsert ON CONFLICT(habit_id,due_date,due_time) with race guard, `[Habit Check]` naming
habit/step k/N/level/check, first-tick-of-day sweep auto-`missed` on yesterday's open rows).
`weekly-review.ts`: opens with the FIRST CONCRETE Phase-1 question; books a durable +45min one-off wake
doc directly into ll5_scheduled_wakes (source weekly-review-fallback, deduped) whose payload starts
`[Weekly Review — Solo Fallback]` and carries the solo one-pager contract; calendar block delegated to
the agent (`create_tickler` in nudge — gateway Google client is read-only). `calendar-review.ts`: prep
obligation appended (book the prep THIS TURN, governor only credits booked ping_later).
`anomaly-monitor.ts` +2 checks: behavior.forward_work_stalled (staleness, ping_later >48h) +
behavior.ungrounded_pings (rate-shift rise, ping_now with grounding_calls=0). server.ts: eval-moments
mapping + telemetry passthrough for `grounding_calls` int. Gateway 462/462 tests, tsc clean. **gtd:**
migration `002_habit_contracts.sql` (gtd_habits + gtd_habit_log per DECISION-019 schema, idempotent);
habit repository (interface+PG) + 5 tools create_habit/update_habit/log_habit_outcome/list_habits/
habit_trends (validation, tz-aware defaults, weekly completion buckets, excused-neutral streaks,
recent misses); 97/97 tests. **awareness:** query_im_messages now returns per-conversation
`visibility: full|inbound_only` (outbound field = `from_me` bool, dynamically mapped — written by
gateway processors/message.ts; ONE size-0 terms-agg query over trailing 30d) + a visibility_hint
forbidding "you haven't replied" claims on inbound_only threads; 204/204 tests. **ll5-run:** EVAL
RECORDER ROOT CAUSE found+fixed — `reply(channel:"system")` scheduler acks counted as user delivery,
forcing decision=ping_now (110/135 mismatches were this; the Jul 1 131-ping_now inversion was 128 system
acks from the trip-return backlog, NOT a behavior change). Fix: `_is_user_delivery` — push_to_user
always, reply only web-channel. `grounding_calls` (GROUNDING_TOOLS occurrences per turn) shipped in the
telemetry body. **Pre-fix eval history (Jun 27–Jul 2) is contaminated — don't baseline against it.**
Persona: Hard Rule 15 (grounded action claim-class→source map + relative-time-resolves-against-source-
timestamp + absolute-day format), staging-is-a-deferral contract, habit-tools routing. Skills: NEW
`evening-close` (2-min close: ≤3 loose ends, tomorrow's ONE thing, habit line, explicit pick-up/drop per
embedded item); `review` solo mode (`[Weekly Review — Solo Fallback]` → one-pager, 30d+ → someday,
groceries → shopping, ≤3 decisions); `calendar-review` dossier step (get_person + narratives + GTD
mentions before the brief) + prep-commit. Channel dispatch: `[Evening Close]`, `[Habit Check]`, updated
`[Weekly Review]`. All 5 hook test files pass. Deploy = gateway+gtd+awareness (CI) + ll5-run together.
Post-deploy verify: fire evening-close via knob override, near-term test habit through HabitScheduler,
create 3 Ritalin habit rows IN PARALLEL with legacy wakes (cancel wakes only after 3 clean days),
confirm grounding_calls indexing + visibility field live.

### Companion-usability review → DECISION-018/019/020 + phased plan (2026-07-02)
Full system + audit review of Jun 25 – Jul 2 (932 eval moments, 27 sessions, week of journal/GTD/chat/
audit-log telemetry, qualitative read of live-agent transcripts). Verdict: excellent at running the
existing day (morning decision-locks, in-day logistics, Ritalin escalation), weak at forward/weekly
planning and non-deterministic habits. Key findings: `ping_later` = **1 of 932** moments (persona rule
alone didn't move behavior); silent-level staging is a black hole (free-block/triage proposals get zero
engagement — "published where the user doesn't look"; user msgs fell 20-36/day → 6-8 by Jul 1-2);
weekly review never ran despite the "run it WITH them" nudge (inbox 40→48, overdue 57→76, April-stale
actions poisoning free-block suggestions); habits without deterministic machinery decay (training skips
absorbed silently) while the wake-driven Ritalin chain works; 5 trust incidents in one week from
asserting inference over available sensors/stores (wifi, stale next_event, one-sided WhatsApp thread
staleness, relative-date "יתפנה למחר" miss, sitter thread) — ~20% of user messages were system
troubleshooting; tool telemetry shows self-maintenance dominance (list_narratives 3,530 / recall_lessons
1,892 / write_journal 1,832 vs get_situation 41 / list_events 31 / get_person 13). Also flagged:
eval-recorder suspect (138 mismatches all `claimed suppress/actual ping_now` + inverted Jul 1
distribution — verify before trusting). Decisions (accepted): **DECISION-018** planning beats (new
evening-close scheduler+skill with gateway-embedded staged-item collection, staging=deferral contract,
weekly review as calendar-blocked session with +45min solo fallback + GTD decay, prep-commit obligation
+ `behavior.forward_work_stalled` anomaly check, Today card later); **DECISION-019** habit contracts
(gtd PG `gtd_habits`+`gtd_habit_log`, 5 tools, gateway HabitScheduler firing `[Habit Check]` steps,
outcomes into evening close + trends into weekly review; Ritalin migrates first, then training/sleep/
bright-lines); **DECISION-020** grounded action (sensor-before-assertion hard rule + claim-class lookup
map, meeting-prep dossier obligation, deterministic one-sided-thread visibility guard in messaging MCP,
relative-time resolution rule, `grounding_calls` per eval moment + `behavior.ungrounded_pings` check).
Phased plan with KPIs/baselines: `docs/implementation/companion-usability-plan.md` (Phase 0 trust+
instrumentation first). Docs only — no code shipped yet.

### Forward-planning made a first-class, measured outcome (2026-07-01)
Investigated "the agent isn't doing enough prep/forward planning" — confirmed true and found the eval
governor was **blind to it**. `eval_record.py`'s `decision` field was 2-way (`ping_now` if a message was
delivered, else `suppress`), so `ping_later` (staging) was folded into `suppress` — a staged prep brief scored
identically to silence, and `eval_moments` had **0 `ping_later` docs all-time** despite the agent claiming it
~26×/6d (the real intent lived only in `decision_claimed`). Fix (ll5-run `eval_record.py`): `decision` is now
a 3-way ground truth — `ping_now` (delivered), **`ping_later` (BOOKED a `create_wake`/`create_tickler` this
turn — a real forward commitment)**, `suppress` (neither). `decision_mismatch` redefined to `claimed != actual`,
which now flags the key failure: a claimed `ping_later` that scheduled nothing is a hollow miss. Gateway
already stores `decision` as a free keyword (no enum) so `ping_later` indexes fine (comment updated). Persona
`[Calendar Review]` gained a "commit the prep, don't just name it" rule (stage via `ping_later`+`create_wake`
or an instruction-tickler; the governor now only credits `ping_later` when a wake/tickler was booked). Tests:
`test_eval_record.py` updated for the 3-way + a staged-wake case (all eval-record + frozen tests pass). Diagnosis
notes: `coach-scan` IS firing weekly (Jun 28/21/20, produced the Jun 28 tickler burst) — the gap is the DAILY
loop not committing prep between the weekly strategic bursts. The 48h skill-watch now also traces forward-work.

### Fix: nightly journal-consolidation skipped on "Unknown skill: consolidate" (2026-07-01)
The live agent skipped its 02:00 consolidation the night of Jun 30→Jul 1 (journal: *"skill unavailable,
chore skipped"*). Root cause: `journal-consolidation.ts` nudge said **"Run /consolidate"**, but the LL5
skills are flat `.claude/skills/*.md` files — NOT registered slash-commands/Skills in this harness (there is
no `.claude/commands/` dir; the available-skills registry is built-ins only). The agent called the Skill tool,
got `Unknown skill: consolidate`, and — at 02:00 — treated it as a hard stop and skipped the whole chore. It
had worked the two prior nights only because the agent happened to do the work INLINE from the nudge's own
instructions; the failure was a brittle give-up, not a registry regression (the skill file exists, CLI 2.1.138
unchanged). The last SUCCESSFUL consolidation was the night of Jun 29→30 (02:00, "Overnight consolidation
done"). The async narrative-loop (DECISION-015) was healthy throughout — unrelated.

**Proper fix (2026-07-01, follow-up):** the real root cause was that all 16 LL5 workflows were flat
`.claude/skills/*.md` files, which Claude Code does NOT register as invokable skills — so `Skill("consolidate")`
was genuinely unknown. Verified empirically that the container harness DOES register dir-format project skills.
**ll5-run:** converted all 16 to `.claude/skills/<name>/SKILL.md` dirs + `name:` frontmatter (fixed a
YAML-breaking `": "` in coach-scan's description that would have silently blocked it); added a persona "Your
skills — registered; invoke them" section (rule: a named skill/nudge = invoke via the Skill tool; never skip a
chore on a lookup error — do it inline if invocation fails) + by-trigger map; updated 5 stale skill-path refs +
the channel [Morning Briefing] dispatch. **gateway:** the `journal-consolidation` nudge now says **invoke your
`consolidate` skill** (was the interim "read the flat file", whose path no longer exists after the move), with
the anti-skip guard retained; composite-triggers comment path updated. +3 tests (`journal-consolidation.test.ts`:
no `Run /consolidate`, invokes the skill, not the old flat path, anti-skip guard present). A 48h skill-usage
watch traces real invocations post-deploy.

### Fix: inbound-throughput anomaly false-fires overnight — day-of-week baseline (2026-06-30)
`anomaly-monitor.ts` `throughput.inbound_messages` ("Inbound message volume dropped") compared the current
2h inbound count to the SAME window **yesterday** — seasonality-proof for the daily curve but not for the
WEEK. On 2026-06-30 04:37 it fired `18 in the last 120m vs 116 same window yesterday` (Jun 29's pre-dawn
window was a fluke burst; Jun 30's was the normal dead-of-night trough), re-notified 6×, auto-resolved 07:07
when morning traffic returned — and the live agent surfaced it in the AM briefing as "fix the bridge." The
bridge was healthy throughout: `messaging` up 7d / 0 restarts / 0 errors, inbound flowed every hour for 60h
with no gap. Root cause: "same window yesterday" crosses the weekday/weekend (Shabbat) boundary and is
high-variance in the low-count overnight trough. Same family as the Jun 27 `channel.whatsapp` "ingestion
stalled" alert (notify ×19, the one that confused Rotem). Fix: baseline is now the **median of the same
window on the same weekday over the last 3 weeks (7/14/21d back)** — robust on both axes (time-of-day AND
day-of-week) and to a single anomalous week. `median()` helper; current-window query failure still skips;
`minBaseline`/`minChangePct` semantics unchanged. Tests rewritten for the 4-count call order + a fluke-week
robustness case (the exact 18-vs-116 incident now does NOT fire) + a dead-feed-with-one-missing-week case.

### Fix: stuck `mcp.errors.*` alert never clearing (2026-06-28)
`mcp-health-monitor.ts` raised `mcp.errors.<service>` on elevated tool-error rate but only CLEARED a
service still being SAMPLED (>= errorRateMinSamples) below threshold. A service that errored in a burst
then went QUIET (dropped out of the 15-min sample set entirely) left its alert firing forever — observed:
the Ritalin-migration's one-off `complete_tickler` 410s (05:47-06:31Z, benign idempotent-delete) still
alerting `mcp.errors.google` 12h later. Fix: after raising, sweep all FIRING `mcp.errors.*` rows from
`system_alerts` (PG) and clear any whose service isn't spiking THIS tick — covers went-quiet + dropped-below
AND is restart-safe (no in-memory state). +3 tests (`mcp-health-monitor-clear.test.ts`). The
`tool.complete_tickler` twin (ToolFailureMonitor) already auto-resolved correctly; the suppress_spike alert
is a real-but-benign noisy-evening measurement (its "broken tool" hint didn't apply — no tool was broken).

### Recent sessions in recall by default + read-the-week on recovery (DECISION-017, 2026-06-28)
Root-caused the "lost after restart" feeling: not missing capability but UNUSED — `recall_everything` is used
regularly (115 sweeps/10d) but passed `sources:["session"]` **0 of 115 times**; the agent never searched the
raw transcripts (`ll5_session_history`, healthy, 39 sessions last 7d) because session search was opt-in +
framed as a noisy last resort. Fix (awareness MCP):
- `recall_everything` now sweeps `ll5_session_history` **by default, time-bounded to 7 days** (per-index
  `last_message >= now-7d` filter; non-session indices unrestricted). New params `session_days` (default 7) /
  `all_sessions:true` to widen; **empty query → `match_all`** (read-back the window with `mode:"timeline"`).
  Thin hint flipped from "use sources:[session]" → "**widen** session_days/all_sessions — dig, don't give up." Plus a **session floor**: long transcripts get out-scored by short distilled docs (BM25 length bias) and miss the fetch window, so a dedicated session fetch guarantees ≥3 recent sessions surface.
- NEW tool `recent_sessions(days,limit)` — compact one-row-per-session map (span, msg count, opener; no bodies). Opener = first non-assistant message (role is `human` in newer session docs, `user` in older — fixed after live verify showed empty openers).
- ll5-run `session-start.sh` injects a 7-day session digest on EVERY start + a dig-in directive; the compact
  branch adds a forceful "you just lost your thread — read the last 7 days before acting." Persona Hard Rule 12
  updated (recall includes recent sessions; read the week on recovery). Tests: recall-everything.test.ts +6 (19).
- Deferred follow-up: per-session distilled summaries so "read full week" is cheap (DECISION-017 open item).
- **Recency-weighted ranking (2026-06-28):** default `relevant` sort is now a blend — normalized BM25 + a time-decay bonus (half-life 7d, weight 0.5) — so a fresh hit rises without ignoring relevance (recency-blind BM25 buried decisive recent updates). `timeline` stays pure-recency. Session floor now merges BEFORE the sort (ranked, not tail-appended). Recovery steers `mode:"timeline"` (compact hook + digest directive). +2 tests (21 recall / 196 awareness).

### Durable precise-time self-wake — `create_wake` (DECISION-016, 2026-06-28)
The CronCreate retirement (below) left a gap: ticklers are durable but **coarse** (the gateway
`TicklerAlertScheduler` fires on a **2-hour lookahead**, not at the tickler's minute), so they can't do
time-of-day or staggered self-wakes — which is exactly what the agent reached `CronCreate` for (the Ritalin
escalation "arm a 4-step cron chain"; `cron=5` blocked attempts/day in the behavior watch). Fix: a first-class
**precise-time self-wake**, gateway-executed (deterministic — no re-arm, survives restart/compaction).
- **awareness MCP** NEW `src/tools/wakes.ts` — `create_wake({fire_at ISO+offset, payload, kind:instruction|reminder, recurrence:none|daily|weekly|weekdays, tz?, source?})`, `list_wakes`, `cancel_wake`; new ES index `ll5_scheduled_wakes` (`setup/indices.ts`); registered in `tools/index.ts`.
- **gateway** NEW `src/scheduler/wake-scheduler.ts` `WakeScheduler` — ticks 60s, fires due rows as `[Agent Instruction]`/`[Reminder]` via `insertSystemMessage`; one-offs at their instant (expire >6h late), recurring by **local wall-clock compare** in the wake's effective tz (DST-safe), per-day dedup, 90-min catch-up cap so a missed recurring wake never fires stale. Registered in `scheduler/index.ts`; `__tests__/wake-scheduler.test.ts` (10). No active-hours gate (agent owns timing).
- **ll5-run:** Hard Rule 6 + "Scheduling"/"Schedule your own attention" rewritten to split **precise self-wake → `create_wake`** vs **user calendar reminder / coarse lead-time review → `create_tickler`**; `cron-block.sh` redirect now points at `create_wake`. Chosen over "shadow+reconcile real crons" (re-arm is agent-mediated, fragile for a health-critical med path) — see DECISION-016.
- **Ritalin migration:** the "arm a session cron chain" tickler playbook → 4 recurring daily `create_wake`s at 08:45/09:00/09:10/09:25, each idempotent (check dose GTD action; escalate or no-op).

### Durability: retire CronCreate → DB-backed ticklers (2026-06-27)
Audit ("nothing the agent relies on should be session-scoped"). Found: the agent's `CronCreate` jobs are
**session-scoped in visibility** — `CronList` only lists the current session's crons, so after a restart/
compaction the agent can't see or manage a cron it created earlier and wrongly concludes it's gone (this is
how a real user-set "brothers-trip" watch at 11:23/19:23 was lost). Fix (ll5-run persona): **all recurring
schedules / reminders / self-wakes now go through ticklers** (`create_tickler`, `kind:"instruction"` for
silent self-wakes, `recurrence`, in the calendar DB, always listable via `list_ticklers`) — `CronCreate` is
retired (Hard Rule 6 rewritten; "Scheduling"/"Schedule your own attention"/situation-check updated; stop =
`complete_tickler`; welcome.md cron-reconciliation marked legacy). `/schedule` cloud routines kept ONLY for
separate cloud-agent work. **Memories were already DB-backed** (DECISION-013 governed memory + the
`memory-intercept.sh` Write/Edit hook → `ll5_agent_lessons`; container has no native memory files) — verified,
no change. **Enforcement (2026-06-27):** a PreToolUse hook `ll5-run/.claude/hooks/cron-block.sh` (matcher `CronCreate`) hard-DENIES `CronCreate` with a redirect to `create_tickler` (CronList/CronDelete pass through; fail-open). So the no-cron rule is deterministic, not just persona. Also `repo-write-block.sh` (PreToolUse Write|Edit) denies the agent writing inside /workspace/ll5-run/ (its own code/skills/persona — Hard Rule 1, and self-edits are lost on deploy) and routes it to the durable alternative (governed memory / push_to_user / /tmp scratch).

### Monitor "second agent" coverage (2026-06-27)
Closed the two gaps in watching the narrative-loop worker: (1) the `ToolFailureMonitor` alert now surfaces the
failing calls' `session_id`(s) (a `sessions` sub-agg) for live-vs-worker attribution; (2) the worker
(`narrative-loop.sh`) runs `claude -p --output-format json` and logs `sess=<id>` + real cost per tick, so an
alerting session maps definitively to the worker (vs the live agent); (3) the worker prompt
(`prompts/narrative-loop.md`) gained a Rule-14-lite self-heal (malformed-arg error → re-read schema + retry
once). The worker still runs without CLAUDE.md/hooks (neutral cwd) by design — full Rule 14 + eval-moments
don't apply — but its tool failures + liveness ARE covered (`app_log` + `loop.narrative_consolidation`
staleness). +1 test (15 monitor total).

### Post-compact re-grounding via active narratives (2026-06-27)
After a context compaction the live agent came back "clueless about the past day" — the compact branch of
`ll5-run/.claude/hooks/session-start.sh` (fires on `source=compact`) loaded only open journal entries. Fix:
it now also loads the **active narratives** (relevance-sorted top 12 — the agent's living context cards, kept
fresh by the consolidation loop) so the agent re-grounds on the real recent threads (trips, family-medical
arc, school schedule, …) + open journal + user_model + lessons, and is told to `recall_everything` on
anything uncertain before acting. Added `KNOWLEDGE_URL` to the hook. Live-tested the query (rich, current
recap). A compounding payoff of the loop: fresh narratives make a *reliable* recovery source. (The companion
"somewhat broken" tool issue after compaction = the `inspect_image` arg-drift, already fixed via Hard Rule 14
+ the channel handler.)

### Tool-failure backstop monitor (2026-06-27)
The deterministic net under agent Hard Rule 14 — independent of whether the agent notices, the system
alerts when a tool is *failing repeatedly* (the inspect_image breakage went unnoticed for 2 days).
- **Channel-tool telemetry**: the channel MCP (in the agent container, no ES access) now reports every tool
  result to the new gateway `POST /telemetry/tool-result` (authed) → `appLog.info('tool_call', …)`, closing
  the blind spot where channel tools (inspect_image/reply/push) never reached `ll5_app_log`. Central wrap in
  `ll5-channel.mjs` (renamed handler to `__callToolImpl` + a logging wrapper + `logToolResult`); success-logs
  skipped for chatty no-risk tools (get_current_time/narrate/…), failures always logged.
- **`ToolFailureMonitor`** (`gateway/src/scheduler/tool-failure-monitor.ts`): every 15 min queries
  `ll5_app_log` per-tool over a 60 min window; `raiseAlert` (existing spine → phone push + `[ALERT]` to the
  agent) when a tool has **≥4 failures AND fails ≥50% of its calls** (broken, not flaky); delivery/perception
  tools (reply/push_to_user/send_*/inspect_image) escalate to `critical`; auto-clears on recovery. Knobs:
  `tool_failure_{monitor_minutes,window_minutes,min_failures,min_ratio}`. +5 unit tests; gateway `tsc` clean.
### Generic anomaly monitor — Phase A (2026-06-27)
`gateway/src/scheduler/anomaly-monitor.ts`: a declarative, no-ML anomaly watcher on the same alert spine.
Two detector kinds wired: **staleness** ("did it stop" — newest data point older than maxMinutes) and
**rate-shift** (count in the current window vs the SAME window *yesterday* — seasonality-proof, alerts on a
big drop). Starter checks: **narrative-loop liveness** (no `list_narrative_work` call in 45 min → the loop
died), **journaling staleness** (18 h), **inbound-message throughput drop** (< 20% of same-window-yesterday,
baseline ≥ 8). Auto-clears on recovery. Knob `anomaly_monitor_minutes` (15). +7 unit tests (12 total with the
backstop). Adding a metric = push one object into `buildChecks()`.
**Phase B (2026-06-27, built):** agent-behavior anomalies now wired. The eval recorder
(`ll5-run/.claude/hooks/eval-record.sh` + `lib/eval_record.py` new `ship_body()`) backgrounded-curls each
proactivity moment's lean behavior fields to NEW gateway `POST /telemetry/eval-moment` → NEW `ll5_eval_moments`
index (mapping in `GATEWAY_INFRA_INDICES`). The rate-shift detector gained a `direction` ('drop'|'rise');
two behavior checks added: **`behavior.suppress_spike`** (proactive-turn suppression rising ≥2× vs the same
window yesterday — the regime change a broken tool causes) and **`behavior.mismatch_spike`** (claimed-vs-actual
decision disagreement rising). Backgrounded curl keeps the Stop hook non-blocking + dodges the Cloudflare
urllib-403. +2 tests (14 total). Both gateway + ll5-run deploy.

### Chat left rail → live "Active topics" (2026-06-25)
The web chat's left sidebar now defaults to a lightweight, live **Active topics** rail (the consumer surface
of the narrative substrate) instead of the chat list. `components/chat/active-topics-rail.tsx`: active
narratives relevance-ranked (timeliness+centrality), with kind filter (All/Topics/Groups/People) + sort
(Top/Recent) + client-side search; rows are title + freshness dot (recency-colored) + open-threads count;
polls `fetchNarratives` every 45s so it re-ranks as the consolidation loop folds in new activity. A
**Topics | Chats** tab in `chat-root.tsx` keeps the old `ConversationList` one tap away (default Topics).
Clicking a topic opens `topic-card-drawer.tsx` — a slide-over reusing the narratives `NarrativeDetailView`
(pane) + a **Jump in** action (`requestNarrativeSummary` → the agent drops the topic's point-in-time read
into the live chat thread, so you continue with its context in hand). Dashboard `tsc` + `next build` clean.

### Narrative maintenance → async ephemeral-worker loop (2026-06-24, DECISION-015)
Superseded the same-day "live agent spawns a subagent" approach below. The live agent — even just
spawning a Task — still rode its own thread and depended on it noticing the nudge. New design: a
**dedicated, self-pacing loop in the agent container** runs an **ephemeral `claude -p` worker** every
~20 min, completely off the live agent, and **much more sensitive** (the live-agent bottleneck was what
forced the low sensitivity). Full rationale in `docs/decisions/DECISION-015-narrative-maintenance-loop.md`.
- **`list_narrative_work`** tool + `selectConsolidationWork` repo method (personal-knowledge MCP): the
  worker's single driver query — returns `{refresh, create}` against the LIVE `max(observed_at)`, knobs
  `promote_threshold` (default **1**, was ≥3), `debounce_minutes` (45), `window_days` (14), `max` (25).
  +7 unit tests (39 in the narrative repo suite; personal-knowledge tsc clean).
- **ll5-run worker**: `.mcp.narrate.json` (minimal 2-MCP set: knowledge + awareness), `prompts/narrative-loop.md`
  (the silent consolidation task), `scripts/narrative-loop.sh` (sleep-loop driver: `nice`/`ionice`,
  ephemeral `claude -p` sonnet-4-6, `--max-budget-usd`, `--no-session-persistence`, `bypassPermissions`,
  neutral cwd so no CLAUDE.md/hooks load, off-switch `~/.ll5/narrative-loop.disabled`), started from
  `docker-entrypoint.sh` alongside the autoheal watcher. Validated `claude -p` flags + sonnet-4-6 + OAuth
  live in the container.
- **Why ephemeral, not `/loop`-proper**: a one-shot `--print` worker exits, so ScheduleWakeup/`/loop` can't
  re-arm it; a standing 2nd `claude` is a real cost on the shared box. The sleep-loop = same self-paced,
  off-main-agent behavior at ~10-15% duty cycle, crash-robust, version-independent. Container runs claude 2.1.138.
- **Gateway heartbeat now DEFAULT OFF** (`narrative_consolidation_enabled ?? false`) — the loop is the sole
  driver; the live-agent path (subagent + dispatch + nudge) stays in place as a **re-armable fallback**
  (flip the flag true to restore it).
- Verify next: loop ticks in the container log create/refresh narratives + write one journal note; orphan
  backlog drains over the first cycles; box stays healthy.

### Narrative freshness → delegated to a background subagent (2026-06-24, SUPERSEDED by DECISION-015 above)
The freshness loop ships and fires correctly, but the **live agent only did ~1–2 consolidations per
`[Narrative Freshness]` nudge** — it won't grind a silent multi-item chore while prioritizing real-time life,
even with small batches at idle hours. Detection/scheduling/UI were all correct; the weak link was the agent
*doing* the work. Fix: the live agent no longer consolidates inline — it now spawns a **single-purpose
background subagent** that works the whole named list to completion.
- **New subagent** `ll5-run/.claude/agents/narrative-consolidator.md` (knowledge-MCP narrative tools +
  `write_journal`; silent — no user-contact tools). Job = "REFRESH/CREATE exactly these named subjects
  (consolidate_narrative → upsert_narrative with `last_consolidated_at`), finish the list, return a one-line
  tally." Gets no real-time events, so unlike the live agent it has no excuse to leave items undone.
- **Dispatch rewired:** the `[Narrative Freshness]` entry in `ll5-run/channel/ll5-channel.mjs` and the
  trailing action sentence in `gateway/src/scheduler/narrative-consolidation.ts` now say "spawn the
  narrative-consolidator subagent ONCE (Task, `run_in_background: true`) with the REFRESH/CREATE lists" instead
  of "do it yourself." Rationale: spawning one Task is a tiny action a busy agent WILL do; a single-purpose
  subagent works its list to completion. Falls back to inline if Task is unavailable (batch is ≤9: max 5
  refresh + 4 create). The server-side selection logic (live `max(observed_at)`, debounce, orphan promotion)
  is unchanged — only the *action* the agent is told to take changed.
- Gateway `tsc` clean. Verify on the next freshness cycle: a `[Narrative Freshness]` nudge should produce a
  `narrative-consolidator` subagent run + a "Narrative freshness: refreshed N, created M" journal note, and
  the named narratives' `last_consolidated_at` should advance.

### PROJECT: Living Narratives — Phase 1 substrate shipped (2026-06-23)
Turning `narratives` (personal-knowledge MCP) into a living, edge-aware, observable substrate. Full spec +
phasing + confirmed product decisions in `docs/decisions/DECISION-014-living-narratives.md`. Goal: fast,
reliable on-the-fly context building (a narrative IS the agent's "context card"); the UI (Phases 3–4) is the
window to see/steer it. **Decided:** substrate-first; debounced/cadenced freshness; "summarize now" =
ephemeral (read-only) snapshot; mobile simplified to an "Active" tab.
**Phase 1 (this commit) — backend substrate:**
- **Relevance** (`personal-knowledge/src/types/narrative.ts`): `narrativeRelevance(n, now)` composite
  (recency 0.6 / status 0.2 / open-threads 0.1 / volume 0.1; ~3-day recency half-life, 0..1). `list_narratives`
  gains `sort="relevance"` — computed in-app over a 200-candidate window so it uses the LIVE observation count,
  not the stale stored one (recency sort unchanged/default). Added `place_id` filter.
- **Edges/map**: new `get_narrative_connections({subject})` tool +
  `NarrativeRepository.getConnections` — returns entity spokes (participants+places, names resolved via
  person/place repos) + related narratives via **shared-participant / shared-place / co-subject** (co-tagged
  observations), each with `via[]`, `weight`, `sharedKeys[]`. Derived on read, no stored edges. Co-occurrence
  helper queries `ll5_knowledge_observations` directly (sibling of `liveObservationCounts`).
- **Freshness loop** (`gateway/src/scheduler/narrative-consolidation.ts`): upgraded from once/day blind nudge
  to **cadenced + server-selected + debounced**. Now takes the ES client; fires every `intervalHours`
  (default 3) within 07–22; itself queries `ll5_knowledge_narratives` for active narratives with
  `last_observed_at > last_consolidated_at` (new activity since last summary) not refreshed within
  `debounceHours` (default 6); nudge (`[Narrative Freshness]`) NAMES the exact narratives so the agent
  consolidates precisely those — a 12-msg burst is one rewrite per debounce window, not twelve. Knobs:
  `user_settings.scheduler.narrative_freshness_{interval_hours,start_hour,end_hour,debounce_hours,window_days,max}`.
- Tests: +5 `narrativeRelevance` unit tests (ordering/bounds) — personal-knowledge 90 green. Both packages
  `tsc` clean.
- **Live-timestamp correction (caught in verification):** a narrative's stored `last_observed_at` is only
  written at consolidation, so it always trails `last_consolidated_at` — using it would make the freshness
  selector blind (it returned "no stale-active" even though e.g. Ben C had fresh observations) and skew
  relevance. Fixed: `liveObservationStats` now also computes live `max(observed_at)` per subject and
  overwrites `lastObservedAt` on read (relevance now ranks by true activity); the scheduler selects on the
  live max(observed_at) vs `last_consolidated_at`, not the stale doc field. Verified live: scheduler runs
  with the cadenced config and server-selection returns a true result against real ES data; observation
  writes confirmed healthy (48/24h, 95/48h, 354/7d).
**Phase 2 (gateway `/narratives` API) — shipped 2026-06-23:** new `packages/gateway/src/narratives.ts`
router (mounted in `server.ts`, same `chatAuthMiddleware` Bearer auth), proxying the personal-knowledge MCP
by forwarding the caller's token (user-scoped, multi-tenant-safe; connects per request like the MCP health
probe): `GET /narratives?status=&sort=&q=&subject_kind=&limit=&offset=` (default sort=relevance) → `{narratives,total}`;
`GET /narratives/detail?kind=&ref=` → `{narrative, observations, connections}` (parallel `get_narrative` +
`get_narrative_connections`); `POST /narratives/summarize {kind,ref}` → fires an **ephemeral** agent summary
via `insertSystemMessage` (`[Narrative Summary Request]`, instructs push_to_user + DO NOT upsert) returning
`{event_id, message_id}` for UI correlation. One API surface for web + mobile (mobile can't do the MCP
handshake). gw `tsc` clean.
**Phase 3 (web master-detail UI) — shipped 2026-06-23:** dashboard `/narratives` refactored from list→separate-route
into a **master-detail** screen. Left rail: search + status/kind filters + a **relevance/recency sort** toggle
(default relevance). Right pane (`NarrativeDetailView variant="pane"`, shared with the still-working `/detail`
deep-link route): summary/mood/open-threads/decisions + a **connections graph** (`narrative-graph.tsx` — zero-dep
SVG radial; center = narrative, spokes = entities + related narratives, edges colored/dashed by via
shared-participant/shared-place/co-subject, related nodes clickable to pivot) + a **development timeline**
(`narrative-timeline.tsx` — pure-Tailwind rail merging observations + recentDecisions chronologically, source
badges) + a **"Summarize now"** button (ephemeral: `requestNarrativeSummary` → gateway `POST /narratives/summarize`,
then subscribes to `/api/chat/listen` and renders the agent's reply inline as "Fresh take", 60s fallback; does
NOT mutate the stored narrative). server-actions gained `sort`, `fetchNarrativeConnections`, `requestNarrativeSummary`.
Dashboard `next build` clean.
**Phase 4 (mobile "Active" tab) — shipped 2026-06-23 (ll5-android repo):** new bottom-nav **Active** tab listing
relevance-sorted active narratives (search), tap → detail (summary, open threads, participants/places as text,
related titles as chips, recent observations list) + a **Summarize** button (fires gateway summarize, snackbar
"check Chat"). New `NarrativesApi`/`NarrativeDtos` (camelCase, `{narratives:[...]}` envelope)/`NarrativesRepository`
+ `ui/narratives/` (list+detail VMs/screens) + `NarrativeTime.kt` (ISO relative-time); first arg-bearing nav route
(`narrative/{kind}/{ref}`, Uri-encoded). Uses the Phase-2 gateway endpoints. `assembleDebug` BUILD SUCCESSFUL.
**Living Narratives: all 4 phases shipped + verified (Phase 1 freshness live-checked: scheduler `Freshness
trigger sent count:15`; Phase 2 endpoints 401-gated live; Phase 3/4 builds green).**
**Freshness delivery fix (2026-06-23):** end-to-end verification found the first nudge (fired at gateway
start, mid-deploy, 06:55Z) was LOST — the non-durable PG NOTIFY raced the channel MCP's SSE reconnect, so
the agent never saw it (StuckMessageSweep later flipped the row to `delivered`, masking it; 0 narratives
consolidated). Root cause: the scheduler fired on arbitrary restart ticks. Fix: added a **top-of-hour gate**
(`fireWithinMinutes`, default 10) — the nudge only fires near the top of a qualifying hour, so a mid-hour
restart (deploys, frequent ES-cascade restarts) neither races delivery nor re-triggers a consolidation
burst; it fires on the clean cadence boundary instead.
**Loop closed (agent-action fix, ll5-run `b8453b9`):** end-to-end testing then found the agent IGNORED a
correctly-delivered nudge — the channel MCP system-message dispatch table had no `[Narrative Freshness]`
entry, so the agent had no directive to act (it kept handling real-time WhatsApp). Added an imperative
dispatch entry in `ll5-run/channel/ll5-channel.mjs` (for each NAMED narrative: consolidate_narrative +
upsert_narrative this turn, silent, don't defer). After the ll5-run redeploy cycled the agent session,
a fired nudge produced exactly the 3 named narratives (Rotem 06-18→06-23, Aristo 06-17→06-23, Uriyah
06-20→06-23) consolidated in one turn within ~3 min. ****Narrative PROMOTION fix (2026-06-23):** user reported "many things I dealt with today aren't there." Diagnosis: narratives are created lazily and the freshness loop only REFRESHED existing narratives — it never CREATED one for a net-new subject, so today's new people/topics (e.g. 40 obs / 14 subjects, only 4 had a narrative) stayed invisible. Fix: the freshness scheduler now also finds ORPHAN subjects (>= promote_threshold recent observations, no narrative — default 3 over the 14d window) and nudges the agent to CREATE a narrative for each. `selectStaleNarratives` -> `selectWork()` returns {stale (refresh), orphans (create)} from one observations pass; the `[Narrative Freshness]` nudge now has REFRESH + CREATE sections (orphans carry a sample observation since person refs are UUIDs). Knobs: narrative_freshness_{promote_threshold,max_orphans}. **Reliability:** end-to-end testing showed the agent STARVES silent consolidation/creation behind real-time events during busy active hours (CREATE nudge sat unprocessed in a 6-row backlog while the agent handled family WhatsApp). REFRESH only succeeded earlier because it was fired right after a restart (spare cycles). Fix: freshness window widened to around-the-clock (start_hour 0) so the dependable OVERNIGHT idle ticks clear the backlog — same regime the old 3am consolidation worked in. Daytime ticks stay best-effort; the always-live observation timeline + on-demand Summarize cover real-time. NOTE: truly comprehensive coverage may need a dedicated consolidation worker (not the live agent) — flagged as follow-up. **2026-06-24 follow-ups:** (a) midnight tick was silently dropped — getCurrentHour rendered 00:00 as 24 (Intl h24 cycle) failing the <=23 gate; fixed with %24. (b) the agent did 0 consolidations on 24-item nudges (15 refresh+10 create) — too big to act on (working runs were 2-5 items); cut maxNarratives 15->5, maxOrphans 10->4 so each nudge is digestible and the frequent cadence clears the backlog over many small ticks.
**Relevance now weights centrality (2026-06-23):** `narrativeRelevance` rebalanced to the user's "timeliness + centerness" intent — recency 0.5 / **centrality 0.25** (participants+places, log-scaled) / status 0.1 / open-threads 0.075 / volume 0.075. Drives `sort=relevance` on web + the mobile Active tab. Also fixed a mobile detail-screen crash (ObservationDto.confidence was Double, backend sends a string enum) and added a type filter (person/place/group/topic) to the Active tab. 91 personal-knowledge tests green.
The freshness loop now verifiably refreshes
narratives end-to-end (fire → deliver → recognize → consolidate → fresh summary).** Note: the loop depends
on the ll5-run channel dispatch entry being live (cycled with the agent session).

### FEATURE: human-approval gate on conversation AUTHORITY (permission) changes (2026-06-22)
The LL5 agent can no longer change a conversation's authority (`contact_settings.permission` — ignore |
input | agent, controls whether the agent may read/reply/post) directly. It may only **file a request**;
the change is applied solely by a **phone/dashboard-authed gateway endpoint** the agent has no path to.
**Table** (gateway migration `034_permission_change_requests.sql`): `permission_change_requests`
(id, user_id text, platform, conversation_id, target_type, target_id, display_name, current_permission,
requested_permission, status `pending|applied|rejected|expired` default pending, created_at, decided_at,
expires_at default now()+24h; index on (user_id,status)).
**Messaging MCP — deferred write:** `update_conversation_permissions` resolves the target as before, reads
the CURRENT permission, then INSERTs a pending request + `pg_notify('permission_approval', userId)` instead
of upserting contact_settings — returns `{pending_approval:true, request_id, …, message:"…requires your
fingerprint approval…NOT applied…"}` and audits `permission_change_requested`. `set_contact_settings`
**still applies routing + download_media immediately** (the contact_settings upsert no longer touches the
permission column at all) but **splits `permission` out** into the same pending-request+notify flow; if only
permission was passed, nothing is written to contact_settings (fully pending). The shared helper is
`packages/messaging/src/tools/permission-requests.ts` (`filePermissionChangeRequest`).
**Gateway endpoints** (`packages/gateway/src/approvals.ts`, mounted on the app, same `chatAuthMiddleware`
Bearer auth as other authed routes — phone/dashboard, scoped to the caller's user_id): `GET /approvals/pending`
→ `{pending:[{id, platform, conversation_id, display_name, current_permission, requested_permission,
created_at}]}` (non-expired pendings for the user); `POST /approvals/:id/decide` body `{decision:"approve"|
"reject"}` — row scoped to caller+row user_id (404 on mismatch, no existence disclosure); **approve** upserts
contact_settings.permission=requested_permission (same `ON CONFLICT (user_id,target_type,target_id)` shape the
tool used) + status='applied'; **reject** → status='rejected'; non-pending → 409, expired → marked expired +
409; audits `permission_change_approved`/`_rejected`. **This endpoint is the ONLY code that writes
contact_settings.permission from a deferred request — the agent has NO apply path.**
**Push:** durable Postgres `LISTEN permission_approval` started in gateway startup
(`packages/gateway/src/utils/permission-approval-listener.ts`, mirrors the `/chat/listen` PG-listener pattern
with auto-reconnect) → on notify sends an FCM (`sendFCMNotification`, level `alert`/high) so the phone
prompts. Tests: messaging update-permissions-tool + contact-settings-tools rewritten (files pending, no
contact_settings permission write; routing still instant) — 81 green; gateway `approvals.test.ts` +8
(pending list, approve applies, reject leaves unchanged, cross-user 404, non-pending/expired rejected) —
400 green. `tsc --noEmit` clean both packages.

### FEATURE: deterministic [LL5] outbound-identity gate on contact sends (2026-06-22)
Every message the agent sends to a CONTACT (`send_whatsapp` / `send_telegram` — a non-LL5 channel, i.e.
someone other than the user's own web/mobile thread) MUST begin with the `[LL5]` prefix, so the recipient
knows it's Arnon's AI assistant writing, not Arnon himself. Enforced **non-agentically** at the send
chokepoint: new `packages/messaging/src/utils/ll5-prefix.ts` (`checkLl5Prefix`, regex `/^\s*\[LL5\]/`) is
called FIRST in both send tools (before account/permission/first-contact gates); a non-compliant send is
**rejected (not sent)** with `{sent:false, rejected:"missing_ll5_prefix", correction}` + a `send_rejected_no_prefix`
audit row, and the correction tells the agent to resend with the prefix. The format also lives in the persona
(ll5-run CLAUDE.md messaging section) so the agent normally complies; the gate is the hard floor that doesn't
trust it. `push_to_user`/`reply` (user's own thread) are unaffected. Tests: send-gate.test.ts +3 (9 total),
all existing send tests reprefixed; full messaging suite 79 green.

### FEATURE: Web chat upward pagination — load older history on scroll-up (2026-06-22)
The dashboard chat tile (`packages/dashboard/src/components/chat-widget.tsx`) only ever loaded the most
recent 30 messages with no way to reach older history. Added end-to-end upward pagination. **Gateway**
(`packages/gateway/src/chat.ts` `GET /chat/messages`): new optional `before` query param adds
`created_at < $N` to the WHERE — combined with the existing `ORDER BY created_at DESC … LIMIT … re-sorted
ASC` it returns the `limit` newest rows still older than the cursor (the next page up). `since` (newer) and
`before` (older) are independent. **Dashboard**: scroll handler fires `loadOlder()` when `scrollTop < 120`
(guarded by `hasMoreOlder` + an in-flight `loadingOlder` flag, both mirrored to refs for the stale-closure
scroll callback); it fetches `…&before=<oldest loaded created_at>` and **prepends** the de-duped older rows.
**Scroll is anchored across the prepend**: `scrollHeight` is captured before `setMessages`, then a
`useLayoutEffect` (pre-paint) adds the height delta to `scrollTop` so the viewport stays on the same message
(no jump) and sets `pinnedRef=false` so the auto-scroll effect doesn't yank to the bottom. A page < 30 rows
sets `hasMoreOlder=false`; switching `convId` resets pagination state. The `reconcile()` safety-sweep already
merges as a union (maps `prev`, appends only unseen recent rows — never replaces the array), so it preserves
already-loaded older messages; verified, no change needed. Small "Loading earlier messages…" affordance at
the top while fetching. Gateway tests +2 (before-cursor scoped/limited; since+before independent) — 24 green;
dashboard `tsc --noEmit` clean + build green. Did not touch optimistic send, reactions, isWaiting, or de-dup.

### FIX: Web chat "coach is thinking" stuck indicator + SSE reconnect gaps (2026-06-21)
`packages/dashboard/src/components/chat-widget.tsx`. Two coupled bugs made the web chat hang on the
thinking indicator. (1) **Indicator was a fragile 60s status-timer** keyed on the last user message's
`status` (`processing`/`pending`) — a turn longer than 60s cleared the indicator BEFORE the answer arrived,
and a missed/late status NOTIFY left it lingering after the answer showed. Replaced with a render-derived
`isWaiting` (useMemo over `messages`): true only when NO substantive assistant reply has landed AFTER the
last user message. "Substantive" EXCLUDES `metadata.kind === "thinking"` markers, compact/activity rows, and
reactions — only a real assistant chat bubble clears it. Safety cap raised 60s → **150s** so a long turn
keeps showing "thinking" until its answer renders (and never hangs forever if a turn dies). Net: indicator
clears the instant the real answer renders via SSE or the safety poll. (2) **SSE reconnect lost messages** —
`/chat/listen` streams non-durable Postgres LISTEN/NOTIFY; any NOTIFY fired during an `EventSource`
reconnect gap is gone, and the only recovery was the 30s safety sweep (the visible "stuck" window).
Extracted the sweep fetch/merge into a `reconcile()` callback; `es.onerror` now fires `reconcile()`
immediately (~1s recovery instead of ≤30s), and the safety poll runs **adaptively** — every ~4s while
`isWaiting`, backing off to 30s otherwise (de-dup/merge logic unchanged). Gateway `/chat/listen` keepalive
checked: already 30s, comfortably under Cloudflare ~100s idle timeout — no gateway change needed. Build +
typecheck + 61 tests green.

### FEATURE: Android geofence + sleep + current-place push types (2026-06-21)
Gateway ingestion for four new Android push-item types (the app already emits them) plus a registration
endpoint. **`geofence_transition`** `{place_id, place_name?, transition: enter|dwell|exit, lat?, lon?,
timestamp}` is the high-value one: a **`dwell` is now the AUTHORITATIVE arrival signal** — the on-device 60s
loiter already filtered drive-pasts, so `processors/geofence.ts` treats it as a confirmed "Arrived at
<place>", sets the shared `ll5_awareness_location_state` doc to the place (via the now-exported
`getLocationState`/`setLocationState` from `processors/location.ts`, under the SAME
`location-state:<userId>` mutex key) so the GPS `runTransition` path sees the place as current and won't
double-fire, writes a `location_change` notable event, and wakes the agent with `[Location] Arrived at X —
…. [geofence]` (the `[geofence]` tag distinguishes it from the GPS path's `[place match]`/`[city-level]`).
`exit` → clears state to Unknown/city + `Left X` wake (only when state was at this place; otherwise log
only). `enter` is SUPPRESSED (a drive-through fires enter→exit without dwell — waiting for dwell means a
pass never pings). This retires reliance on the GPS motion-gate for arrivals. **`sleep_segment`** /
**`sleep_classify`** → new ES index `ll5_awareness_sleep` (kind `segment`|`classify`); a SUCCESS segment also
writes a `sleep_summary` notable event (`Slept ~Xh Ym (00:10–07:05)`) for the morning wake (note: the
classify key is `motion_level`, not `motion`). **`current_place`** `{candidates:[{name,types,lat,lon,
likelihood}], timestamp}` → new ES index `ll5_awareness_current_place`, store-only enrichment, no agent wake.
New **`GET /geofences`** (Bearer-auth) returns the user's known places as `[{place_id, name, lat, lon,
radius_m}]` from `ll5_knowledge_places` (place_id = ES `_id`, lat/lon from `geo`, radius_m null-allowed),
**filtering out places with no coordinates** (the app rejects null lat/lon). sourceMap entries added for all
3 webhook types (default enabled). 11 new tests; full gateway suite 390 passing.

### FIX: GPS-jamming suspect filter — catch the impossible hop (2026-06-21)
The suspect filter missed a real jamming snap (Binyamina→Amman airport, ~160km, current_timezone briefly
flipped to Asia/Amman). Root cause: its two rules both require the >20km hop PLUS either a confident
known-place wifi anchor (`wifi_anchor_disagreement`) or a reported-stationary device
(`teleport_while_stationary`) — so a jamming jump while the user is MOVING (cycling, speed≥5) and NOT
wifi-anchored slips through both; and `detectDriftGlitch` skips its speed check once the gap ≥
`DRIFT_WINDOW_MIN` (10min), so a 19-min-gap snap isn't dropped either. Added a third rule
(`impossible_implied_speed`): a hop whose implied ground speed exceeds `IMPOSSIBLE_HOP_KMH` (400 — below the
1000 km/h glitch-drop ceiling, above any car/train) is jamming regardless of wifi/reported-speed; only fires
on a short gap (long overnight gaps → low implied speed → the wifi rule carries it). `processors/location.ts`;
2 regression tests (379 gateway tests).

### FEATURE: recall_everything — one unified "what do we know about X" sweep (2026-06-20)
Root problem (from the wife's-calendar-event miss): **data that existed in a store did not surface when
needed.** Answering "what do we know about <topic>" required fanning out across `search_knowledge`
(facts/people/places) + `read_journal` (which only matched `topic`, NOT content) + `recall` + calendar +
messages — and the agent routinely missed a store, so a correction recorded three times in the journal
never resurfaced. New awareness tool **`recall_everything`** runs ONE Elasticsearch query across **every
text-bearing store in the shared cluster** — facts, people, places, profile, data_gaps, observations,
narratives, journal (topic AND content — the gap closed), lessons (world-scoped), calendar events, IM
messages, entity statuses, notable events — and returns unified, score-ranked, per-source-capped results
with highlights. Cross-store READ only (no cross-MCP HTTP); world-scoped lessons admitted via `_index`,
everything else `user_id`-scoped; retired lessons excluded. When the sweep is **thin/empty** it returns a
`coverage` flag + `suggest_postgres: [gtd, gmail]` so the agent escalates to the Postgres stores it already
holds (kept agent-driven, not a subagent, until the hint-based ladder proves insufficient). **Raw session
transcripts (`ll5_session_history`) are an OPT-IN source** — NOT swept by default (un-distilled chatter
would dilute precision), included only when the caller passes `sources:["session"]`; a thin default sweep now also emits
`suggest_sessions` pointing the agent at that deeper layer. **Searchability fix:** session docs map
`messages` as `enabled:false` (store-only, never indexed) — so the gateway `POST /sessions` handler now also
writes `transcript_text` (a flat `multilingual`-analyzed concat of all message texts) and recall_everything
searches THAT; the 155 existing docs were backfilled via `_update_by_query`. (Highlight restricted to the
searched content fields, not `'*'` — the wildcard re-highlighted `user_id.keyword` via the scoping filter, so
snippets were showing the bare user UUID instead of the matched text.) All 13 distilled sources +
session opt-in verified live end-to-end. Each sweep also writes a `recall_sweep` `logAudit` entry
(`ll5_audit_log`, carries coverage/total/by_source/sources + auto session_id) so live usage + recall
quality can be validated through real operation (alongside the `ll5_app_log` tool_call counts).
**`mode:"timeline"`** (2026-06-21) — the default relevance ranking + per-source cap buried a decisive recent
update (a "picked up the glasses Friday" line ranked #24, capped out) under the verbose origin; timeline mode
returns EVERY match most-recent-first with no per-source cap, for status/"did X happen" questions. The
default response also emits **`more_available`** (`{source: {shown, matched}}`) + a `timeline_hint` when
ranking hid more than it showed, via a `_index` terms agg. The grounding-reviewer + consolidate pre-stage are
wired to use timeline for status items; the reviewer's FIX verdict now held to the same grounding bar as KEEP
(no confident correction from soft evidence). Sessions are saved regularly
already (per-turn `session-save.sh` hook → `/sessions` → ES; live data confirms current). First part of the general retrieval-surfacing fix; pending parts: nightly pre-staging,
promote-on-repetition. Tests `__tests__/recall-everything.test.ts` (13). Persona wired (look-before-ask,
call it first — ll5-run). Deployed + verified live (39 tools).

### FEATURE: governed agent memory — intercept native Claude Code memory into ES (2026-06-20)
The agent's native auto-memory was append-only/ungoverned and held two contradictory `create_tickler`
timezone beliefs at once (→ double-booked ticklers). Now governed (DECISION-013): a `ll5-run`
`PreToolUse` hook (`memory-intercept.sh`) intercepts every `Write|Edit` to a `*/memory/*` path, routes
the content to the awareness MCP `ingest_memory`, and **denies the disk write**; recall is replaced by
governed injection (`SessionStart` runbook block + `UserPromptSubmit` `memory-recall.sh`). New awareness
store `ll5_agent_lessons` (+ `_history`, versioned/audited like user_model): tools `upsert_lesson`
(reconcile-on-write — contradictions blocked until resolved), `recall_lessons`, `list_lessons`,
`retire_lesson`, `ingest_memory` (classifies **world** vs **user**: world→global lessons runbook with
auto-merge-in-place, user→`user_model.learned_notes`). Lessons carry claim/trigger/**detail** (the body —
why/how-to-apply — preserved and searchable). Merge/conflict decisions use deterministic claim
token-overlap (overlap coefficient), NOT normalized BM25 (which made the top hit always ~1.0 and
spuriously merged unrelated lessons — caught during migration); classifier leans world for operating
guidance, user only when personal markers dominate. `durable` vs `provisional` (provisional carry a
falsification_test, flagged verify-before-trust). Dashboard `/lessons` page renders the runbook. Spike
validated the hook contract on Claude Code 2.1.178. Pending: migrate existing `feedback_*.md` + clear
the on-disk memory dir (post-deploy); live end-to-end verification.

### FEATURE: reliable speed (hasSpeed) + formal motion (Activity Recognition) with provenance (2026-06-20)
The drive-past + mode-naming root cause was the phone sending a fake `0` speed. Now fixed properly with provenance end to end:
- **Android**: `LocationRepository.resolveSpeed` — GNSS Doppler speed when `hasSpeed()` (rejecting low-confidence via `hasSpeedAccuracy()`), else on-device **derived** speed (`distanceTo` ÷ Δ`elapsedRealtimeNanos`, jitter-gated), else **null** (never a fake 0). Sends `speed_source` ('gnss'|'derived'). The **Activity Transition API** (`ActivityRecognition`, ENTER/EXIT of in_vehicle/on_bicycle/walking/running/still via `ActivityTransitionReceiver` → `CurrentMotionState` singleton) gives a formal `motion` label + `motion_source` ('activity_recognition'). New `ACTIVITY_RECOGNITION` permission; Room v4→5 (speed now nullable + 3 new cols).
- **Gateway**: `push-data.ts` accepts `speed_source`/`motion`/`motion_source` (nullable). `processors/location.ts` prefers the device's `in_vehicle`/`on_bicycle` label for drive-past suppression (derived speed as backstop), persists provenance (`doc.speed_source`/`motion`/`motion_source`), and surfaces `motion=driving[activity] speed=54km/h[gnss]` (or `[inferred]`/`[derived]`) in the `[Location]` event.
- **Prompt**: trust `[activity]`, treat `[inferred]` with suspicion.

### FIX: drive-past place-match — gate on DERIVED speed (reported speed unreliable) (2026-06-20)
The "you're at X" false matches while driving past **recurred** (Optika Cohen / Ben Keitz's matched at 22–90 km/h derived speed). Root cause: yesterday's drive-past gate keyed off the device's **reported** speed, but the phone sends it as `0`/missing on most fixes (the doc had no `speed` at all — the app sends `speed`, the doc-write checked `speed_mps`). So the gate never engaged. Fix (`processors/location.ts`): compute the **derived** speed = distance from the previous fix ÷ time (reliable even with no reported speed), and suppress a known-place proximity match above `PLACE_FLYBY_SPEED_MPS` (2.5 m/s ≈ 9 km/h, new shared constant). `effectivePlaceMatch` (null when moving) is used in the transition **and** the stored doc + the in-batch predecessor chain; the derived speed is now persisted (`doc.speed`) and fed to the resolver so `motion` reads "driving." The resolve-side reported-speed gate stays as a backstop. New regression test (377 gateway tests).

### FEATURE: Coach Phases 2 & 3 — strategic scan, scheduled cadence, event triggers, send-gate (2026-06-20)
Built as four independently-validatable components:
- **2A `coach-scan` skill** (ll5-run `.claude/skills/coach-scan.md`): the weekly strategic layer above situation-check — cross-reads goals/horizons + narratives + open commitments + GTD + calendar 2-4wk out, judges drift/future-reviews/opportunities, **schedules `instruction` ticklers** (the agent calendar) for future reviews, surfaces ≤1 coaching message, journals + `record_moment`. Force-runnable via `/coach-scan` or a `[Coach Scan]` cue; effects observable via `list_ticklers` + journal.
- **2B `CoachScanScheduler`** (gateway `scheduler/coach-scan.ts`): weekly cue (configurable `coach_scan_day`/`coach_scan_hour`, default Sun 8am, effective-tz, once/week dedup, withSchedulerHealth) emitting `[Coach Scan]`. 5 unit tests.
- **3A composite triggers** (gateway): event-driven proactivity instead of waiting for the heartbeat — (1) **arrived + items here** (event-driven in `processors/location.ts` via `utils/composite-triggers.ts` `ArrivalCompositeEvaluator`, fires only when place-matched actions/inbox exist), (2) **free block opened** + (3) **important-contact unanswered >2h** (`scheduler/composite-triggers.ts`, ~3min, conservative per-condition dedup). Emit `[Situation] …`. 12 unit tests.
- **3B send-gate** (messaging): hard guard on `send_whatsapp`/`send_telegram` — a **first-contact** send (0 prior outbound in `messaging_send_log` via new `countSentToRecipient`) is **blocked** unless `confirmed:true`, returns `{sent:false, blocked:"first_contact_needs_approval"}` + audit. Prompt gate now enforced at the tool layer. 6 unit tests. (TODO: real in-app approval record vs trusting the agent's `confirmed`.)
- **Validation**: gateway 376 / messaging 76 tests pass; box-cron watch gained `coach_scan` + `composite` signals; each component force-checkable in isolation.

### FIX: location notifications silent after the agent-owns-notify change (2026-06-19)
A 45-min drive produced zero phone notifications. Root causes (from the eval moments + raw location docs): (1) the agent surfaced the home arrival via `push_to_user` with **no `level`** → chat-only, no phone buzz, and over-suppressed the departure; (2) **every GPS fix had `motion=unknown`** because the Android app sends the speed field as **`speed`** while the gateway reads **`speed_mps`** (zod silently dropped it) — so driving was never detected, the mode couldn't be named, and the drive-past place fix stayed inert. Fixes: gateway `push-data.ts` + `processors/location.ts` now accept `speed` as an alias for `speed_mps` (no APK needed); ll5-run prompt: a surfaced location update MUST use `push_to_user(level:"notify")` (a level-less push is invisible) and meaningful Arrived/Left events are a notify, not journal-and-suppress. FOLLOW-UP (Android): rename the DTO `speed`→`speed_mps` and add `bearing_deg` (Android sends no bearing today → no heading).

### FEATURE: agent owns location notifications + drive-past place-match fix (2026-06-19)
The gateway no longer pushes a location FCM directly. `processLocation` now **wakes the agent** with a clearly-labeled `[Location]` event — `Arrived at X` / `Left X` / `Stopped` / `En route` — plus `motion=`, and the **agent decides** whether/how to notify the user: it recognizes arrivals/departures/nearby-relevant and lets the user know it noticed, names the travel mode (driving/cycling/walking, deducing cycling from speed), with restraint (no town-by-town narration). The `sendFCMNotification` call + import were removed from `processors/location.ts`; the event-cadence logic (arrival/stop/pulse) now gates the agent wake. **BUG FIX (drive-past):** `resolve.ts` now suppresses a GPS-proximity known-place match while DRIVING (`drivingThrough = gps.speedMps >= DRIVING_SPEED_MPS` → `gpsPlace=null`), so you no longer get a false "you're at X" when driving past — a real visit re-registers once you slow/stop or via a connected-wifi anchor. Prompt (ll5-run Location Intelligence) rewritten for agent-owned notify + mode naming. Tests: `location-transition` now assert the agent wake (not FCM); new `location-resolve` drive-past regression tests.

### FEATURE: upload + read non-image files in chat (2026-06-19)
Users can attach non-image files (PDF, txt/csv/md/json, docx/xlsx, pptx, odt/ods, rtf, zip) in web + Android chat. **Gateway upload gate** (`chat.ts` multer fileFilter) widened from image-only to +documents, size cap 10MB→25MB, `MIME_EXT` extended for public uploads. **Web** (`composer`/`use-chat-store`/`message-bubble`) and **Android** (`ChatScreen`/`ChatViewModel`/`ChatRepository`, branch `feat/phone-activity-awareness`) generalized from image-only to a shared attachment contract `{type:"image"|"file", url, filename, mime}` — document picker (`OpenDocument`), raw-bytes upload (real MIME + filename, no Bitmap→JPEG), and a generic file-chip render (was: non-image attachments silently dropped). **Agent channel** (`ll5-channel.mjs`) now emits `[document attached: <url> (filename)]` for non-image attachments (was images-only; docs were dropped before reaching the agent). **Agent reads** via shell: `pdftotext` (PDF, existing), `cat`/`Read` (txt/csv/md/json), `pandoc` (docx/odt/rtf), python `openpyxl` (xlsx) — `pandoc`+`openpyxl` added to the agent Dockerfile; pptx/legacy .doc/.xls not parsed (agent offers PDF). Storage/serving (`/uploads` static, per-user auth), ES `ll5_media`, and awareness `upload_media`/`link_media` were already type-agnostic — no change.

### FEATURE: agent calendar — `kind: reminder|instruction` on LL5 ticklers (2026-06-19)
The agent can schedule its OWN reviews on the LL5 calendar, distinct from user-facing reminders — reusing the existing tickler calendar + sweep, no new store. `create_tickler` gains `kind`: **`reminder`** (default, unchanged — user popup, `[Tickler Alert]`) vs **`instruction`** (agent-private — no popup, blueberry color + `[agent]` title prefix, marked via Google `extendedProperties.private.ll5_kind`). The tickler-alert sweep routes by kind: instructions fire as a per-item **`[Agent Instruction]`** system message (no phone push) carrying the event's full self-contained `description`; reminders unchanged; instructions are filtered out of the user-facing calendar/daily reviews. `kind` flows `/api/ticklers` → gateway `TicklerEvent` → sweep, stored on the ES tickler doc (`calendar_events.kind` keyword) + surfaced in `list_ticklers`. Prompt: the agent schedules `instruction` ticklers at its own **contextual lead time** with a complete note-to-future-self (what/when/why/anchor), and **consults `list_ticklers` before re-deriving** a future need — the calendar holds the decision so it isn't re-made every wake (the anti-re-derivation hook). Example: learns a birthday → schedules a yearly `instruction` review 2 weeks ahead.

### FEATURE: system-wide timezone correctness + location-driven multi-zone awareness (2026-06-19)
Invariant enforced: every stored *instant* is UTC ISO; conversion happens only at the edges using the user's **effective** timezone — their GPS-derived *current* zone when fresh, else *home* (`settings.timezone`). New `@ll5/shared` `utils/timezone.ts` (`timezoneFromLocation` via **geo-tz**, pure `pickEffectiveTimezone`/`isTraveling`, `DEFAULT_WORKING_ZONES` = LA/Berlin/Jerusalem). Producer: gateway `processors/location.ts` derives `current_timezone`/`current_timezone_at` into `user_settings.settings` on a fresh, non-suspect fix. Consumers: `get_situation` now reports a `timezone_info` block (current/home/working_zones/traveling) and computes `time_period` in the effective zone; gateway schedulers resolve effective tz per tick (active-hours follow travel); FCM quiet-hours + day-boundary windows use it; `ll5-channel` message clock + `get_current_time` use it (was hardcoded `Asia/Jerusalem`). **Tickler bug root-caused + fixed**: `create_tickler` used `sessionTimezone()` (→ UTC in the google container, no `TZ` env) instead of the user's stored zone like `create_event` — banking 16:00 as UTC, firing 3h off; now uses the effective zone, `TZ` set on the google service as defense. Per-event Google `timeZone` retained (`calendar_events.timezone` keyword field). Storage audit confirmed all PG timestamps are `timestamptz` and instants are UTC — no migration needed (all-day calendar/`gtd_horizons` DATE naivety noted, fixed forward).

### FEATURE: watchdog now detects Google OAuth disconnect (2026-06-17)
The watchdog had a blind spot: nothing verified Google stayed *connected*. `google` MCP `/health` is
just `SELECT 1` (PG up), `mcp-health-monitor`'s `/health`+`tools/list` pass regardless of OAuth, and
`calendar-sync` swallowed a dead-token failure as a non-blocking `warn` — so a revoked/expired refresh
token (`invalid_grant`, the known #1 Google error) left every signal green while Calendar+Gmail silently
failed. Fix: `scheduler/calendar-sync.ts` now doubles as the OAuth liveness probe — it calls Google every
cycle, so a successful fetch `clearAlert('service.google-auth')` and an **auth** failure
`raiseAlert('service.google-auth', critical, 'Reconnect Google…')`. Auth errors are classified via
`isGoogleAuthError()` (matches `invalid_grant` / "account not connected" / "refresh Google access token";
deliberately NOT a bare 401/403 = gateway↔MCP key). Transient/ES errors stay non-alerting (mcp-health
owns service-down). Reaches the agent + repeat + web/Android banner + critical push, same spine as
WhatsApp. +5 tests (`calendar-sync-auth.test.ts`); gateway 359 pass. The alert's instruction tells the
agent to call `get_auth_url` (google MCP) and **push a one-tap reconnect link** so the user can re-auth
from the app (web or phone) — the dashboard Settings → Calendar reconnect still works too; Android has
no native Google-OAuth UI, so the pushed link is the phone path.

### FEATURE: server-side metrics watchdog + agent/app alert spine (2026-06-16)
A WhatsApp ingestion stall (Jun 15 14:06, Evolution desync) went undetected ~18h: the existing
monitor fleet (whatsapp-flow/phone-liveness/mcp-health/agent-output) only FCM-pushed the phone, capped
at 2 alerts/episode, kept state in-memory, and never told the agent. Fixed structurally with an **alert
spine**: migration `033_system_alerts` (durable firing/resolved state per `(user, alert_key)`);
`utils/alerting.ts` `raiseAlert`/`clearAlert` — on firing they notify the AGENT via an `[ALERT]`
`insertSystemMessage` **always + repeating** (~20min cadence, escalating with firing-duration) and push
the PHONE **severity-based** (critical → FCM `critical`/DND-override, re-push ~30min; warning → once),
and on recovery emit `[ALERT RESOLVED]`. New `GET /alerts` (user-scoped) feeds the apps. All four
existing monitors were rerouted through the spine (drop the 2-cap; WhatsApp staleness 6h→2h, interval
15→10min). New `scheduler/metrics-monitor.ts` (~5min) adds the gap checks: slack/gmail/sms freshness
(baseline-gated so unused channels never alert) + Elasticsearch cluster health. **Web:** `AlertsBanner`
under the nav (polls `/api/alerts`, red/amber, firing-duration, dismiss). **Android:** app-wide
`AlertsBanner` above the NavHost (AlertsApi/Repository/ViewModel, ~45s poll). **ll5-run persona:** an
`[ALERT]` note (surface to user + run the fix tool, e.g. `restart_whatsapp_account`). Gateway 354 tests
pass (+6 `alerting.test.ts` cadence; agent-output test updated to assert the spine); dashboard + Android
typecheck/compile clean. Would have caught the Jun 15 stall within ~5min, repeating, reaching the agent.

### FEATURE: GPS-jamming filter + Places map UI (2026-06-15)
External regional GPS jamming snaps the chip to a far airport (e.g. Queen Alia/Amman) with a confident
accuracy, producing a stray "user is in Jordan" fix. Two-layer defence, no on-device change (the
jamming is external — mock-provider capture is irrelevant). **Write-time flag (gateway
`processors/location.ts`):** a fix that hops >20 km from the previous one is flagged `suspect` when
either (a) the wifi anchor is a confident known place that disagrees with the GPS place
(`wifi_anchor_disagreement`), or (b) the device reports stationary (<5 km/h) while teleporting
(`teleport_while_stationary`). Suspect fixes are still indexed (flagged, for the review map) but the
place-transition notifier is suppressed for them. New ES fields `suspect`/`suspect_reason` added to
`ll5_awareness_locations` (`@ll5/shared`). **Read-time exclusion (awareness
`location.repository.ts`):** a static `NOT_SUSPECT` filter on `getLatest` + `query`, so `where_is_user`
/ trail / visit reads never see a jammed fix. **Agent (ll5-run persona):** a note that jamming is
filtered for it — trust the wifi anchor / last good fix, never tell the user they're somewhere they
obviously aren't. **Dashboard Places UI (`locations/`):** the location map now overlays deduced known
places (`list_places`) as violet radius circles + name labels, plus a right-side "Places" list-panel
(name, radius, address, category, current motion stationary/moving, and a "here now" badge for the
place the user is currently inside). New `fetchKnownPlaces` server action; `where_is_user.motion`
surfaced on the current-location snapshot.

### FEATURE: proactive points-of-change triggers — heartbeat transition cues (2026-06-14)
Diagnosis: the agent stopped calling `get_situation` (~May 23) — the schedulers pre-bake time/
location/schedule into system messages, so the agent reads the injected lines and never pulls the
composite (where the new device_activity/bluetooth signals live). Fix is two-sided. **Agent side
(ll5-run):** persona reframed so `get_situation` is the proactive ANCHOR (call first on every wake +
at points of change), `where_is_user` is reserved for reactive location-only lookups; situation-check
skill gains the new fields + 4 situations (morning-wake, driving, late-night, focus/idle) + new-day
user-model refresh. **Gateway side (this repo):** `scheduler/heartbeat.ts` now fires **edge-triggered
transition cues** — on a time-period flip (morning→afternoon→evening→night) and a new local day —
bypassing the silence gate (each edge fires once, self-gated to active hours), prompting a fresh
situation-check (+ `read_user_model()` on a new day). Events tagged `transition` / `new_day`.
**FIX (2026-06-15):** the active-hours gate ran *after* updating last-seen period/date, so an
overnight new-day / pre-active-hours morning flip was consumed silently and never fired (0 cues
observed). Moved the gate to the top of `checkTransitions` — an overnight transition now fires on the
**first active tick** of the new day. (Verified separately: the persona reframe works — the agent
called `get_situation` at 06:04 local and its result carried `device_activity` + `bluetooth_connected`.)
**Real-time night activity (2026-06-15):** the 15-min poll is Doze-deferred overnight, so a
middle-of-the-night phone-touch didn't reach the agent until morning. Android now has a real-time
`ScreenActivityReceiver` (ACTION_USER_PRESENT/SCREEN_ON) that captures + **pushes immediately** (unlock
forces the device out of Doze, so the network is up). Gateway `processDeviceActivity` adds
`maybeWakeOnNightActivity`: a deep-night (00:00–06:00 local) unlock after a ≥45-min idle gap inserts a
`[Night Activity]` system message (event `night_activity`, 30-min dedup) so the agent KNOWS now rather
than at morning — it reads it gently (most night wakes are nothing). Depends on the process staying
alive overnight (foreground location service + MIUI Autostart/no-restrictions).

### FEATURE: phone-activity awareness — screen/wake, Bluetooth, app-usage (2026-06-13, branch `feat/phone-activity-awareness`)
New situational signals so the agent can tell when the user is up/active, what they're connected to,
and which apps they're using — **battery-first**. Two new push item types riding the existing batched
push: `device_activity` (a per-sync-window rollup the Android app derives from a single
`UsageStatsManager.queryEvents()` poll — screen on/off + unlock + top-app usage, **no always-on
receiver**) and `bluetooth` (cheap event-driven connect/disconnect with a `device_class` car/headset/
wearable). Design: **MCP states facts, agent deduces** (no on-device "wake event"). Data plane DONE
(this branch): `@ll5/shared` indices `ll5_awareness_device_activity` + `ll5_awareness_bluetooth`
(auto-created by `ensureIndices`); gateway `PushDeviceActivityItem`/`PushBluetoothItem` schemas +
`processors/device-activity.ts` + `processors/bluetooth.ts` + `processItem` switch + `sourceMap`
(`device_activity`/`bluetooth`); awareness MCP repositories + surfaced in `get_situation`
(`device_activity` block + `bluetooth_connected[]`); dashboard Data Sources toggles. 3 new gateway
processor tests pass. **Android side (ll5-android) + live ingest verification still TODO.**

### FIX: app_log + audit ES writes silently dead for 8 days (since ES auth) (2026-06-13)
Found while verifying the DECISION-012 tool-ledger: `ll5_app_log` and `ll5_audit_log` had
accepted **zero writes since 2026-06-05T07:36** — exactly when ES auth was enabled
(DECISION-011). The raw-`fetch` writers (`app-log.ts`, `audit.ts`) passed credentials
**inline in the URL** (`http://elastic:pw@es:9200`), which Node's `fetch`/undici **ignores**,
so every write 401'd and was swallowed by the fire-and-forget `.catch()`. (The
`@elastic/elasticsearch` client callers were fine — they parse URL creds; only the raw-fetch
ones broke. DECISION-011 fixed the dashboard's `lib/es.ts` but not these.) Fix: new
`@ll5/shared/es-auth.ts` `esFetchTarget()` derives base URL + a `Basic` auth header; both
writers use it. Added `warnEsWriteFailure()` (throttled stderr) so a fully-broken write path
can't hide silently again (it's how this stayed invisible for 8 days — the no-silent-errors
rule, ironically). Also: `logToolCall` now stores `args`/`result` as **JSON strings** (objects
would dynamic-map per-tool and explode/conflict the index mapping), and `ensureIndices` now
**additively PUTs mappings on existing indices** so new keyword fields don't get dynamic-mapped.

### Observability initiative — DECISION-012 (correlation ids + tool ledger + session accumulation) (2026-06-13)
Design recorded in `docs/decisions/DECISION-012`: make the audit layer the durable,
complete, correlated record of every tool call (extend `ll5_audit_log` with a `kind`
discriminator + full `args`/`result` stored as non-indexed JSON via `withToolLogging`),
add `request_id`/`session_id`/`trace_id` correlation across all actions (shared
AsyncLocalStorage request-context; agent→MCP propagation via the headers-helper), and
replace the SessionEnd-only session dump with **per-turn accumulation** (crash-safe —
the agent restarts constantly). Owner choices: keep everything, PII acceptable
(single-user server), correlation everywhere. Staged rollout. **Stage 1 (per-turn
session accumulation) shipped in ll5-run** (Stop-hook `session-save.sh` +
`lib/session_payload.py`). **Stage 2 (correlation context) shipped in ll5**: new
`@ll5/shared/request-context.ts` (one AsyncLocalStorage carrying `{userId, requestId,
sessionId?, traceId?}`); `logApp`/`logAudit` auto-stamp `request_id` (+session/trace);
all 6 MCPs migrated off their local `userStore` to the shared context (and read optional
`X-LL5-Session-Id`/`X-LL5-Trace-Id` headers — forward-compat for stage 4); gateway gains a
request-id middleware + `request_id`/`session_id`/`trace_id`/`kind` on the `ll5_app_log`
and `ll5_audit_log` mappings. **Stage 3 (audit tool-ledger) shipped**: `withToolLogging`
now also writes a `kind:'tool_call'` row to `ll5_audit_log` with the FULL `args`+`result`
(non-indexed) + correlation ids on every MCP tool call — the durable record the eval-replay
cassette reads. **Stage 4 (propagation) shipped (ll5-run):** the MCP headers-helper
`get-mcp-auth.sh` emits `X-LL5-Session-Id` (SessionStart writes it) + `X-LL5-Trace-Id`
(the ll5-channel MCP writes the trigger id per delivery), so tool-call ledger rows carry
session_id/trace_id. **Stage 5 (cassette) shipped:** gateway `GET /audit/tool-calls`
(filter kind:'tool_call' by session/trace/tool/time, user-scoped) is the cassette query;
the eval moment now records `session_id`+`trace_id` to join to its ledger rows. **Stage 5c
(trace UI) shipped:** the admin **Audit** page now has a "Trace a concern end to end" section
— paste/click any `request_id`/`session_id`/`trace_id` to see every correlated step (app_log
lines + tool-call ledger with expandable args/result), across services, in time order; ids
clickable to pivot, deep-linkable `?trace=&field=` (`audit/trace-view.tsx` +
`trace-server-actions.ts` join `ll5_app_log`+`ll5_audit_log`). **DECISION-012 complete (stages 1-5).** Log/Audit explorer polish: row right-click context menu (filter-by-facet + trace by request/session/trace id), detail panel renders JSON fields (incl. tool args/result) + drag-resizable, default range 1d, time ranges incl. 14d/30d, facet-count layout fix.

### Proactivity eval pipeline — forward scheduler name onto the trigger envelope (2026-06-13)
Supports the proactivity golden-dataset effort (instrumentation lives in **ll5-run**:
a Stop-hook eval recorder + a local `record_moment` tool + an `export-moments` CLI +
the vendored `ll5_label.py`). The one ll5-side change: **migration 032** extends the
`notify_chat_message()` NOTIFY projection (the `meta_proj` added in 024 for `kind`) to
also carry `metadata.scheduler`, so the agent's `<channel ...>` trigger envelope now
includes `scheduler="heartbeat"|"calendar_review"|...`. The eval recorder maps that to a
ground-truth `trigger_class`/`source` instead of guessing from the message text. Additive
and tiny (scheduler names are short, well under the 8KB NOTIFY limit); mirrors 024 exactly
otherwise. No gateway TS change — `insertSystemMessage` already stamps `metadata.scheduler`.

### Full rebuild + redeploy of all services; manual-deploy footgun fixed (2026-06-12)
The location-snapshot push (`d2cfb34`) changed `packages/shared/`, which should rebuild
every dependent — but CI diffs the **tip commit only**, and the tip (`7053a92`) touched just
awareness/dashboard, so gateway/personal-knowledge/gtd/google/health stayed on their
2026-06-05 images (the partial-deploy trap). Forced a full rebuild+redeploy of all 8 via a
docs-only commit (no `packages/*` in the diff → `detect-changes` uses the full 8-package
matrix → deploy job pulls all 8 `:latest` + `up -d`). Also fixed a real footgun: the manual
"How to Deploy" fallback in HANDOFF used `docker compose up -d --remove-orphans`, contradicting
two other warnings in the same doc that it "destroyed 7 manually-started containers
(2026-05-18)" — dropped the flag and documented the force-full-rebuild recipe.

### Location reflected to the agent as one rich snapshot — MCP decides facts, agent deduces (2026-06-12)
Reworked the agent-facing location surface from "MCP bakes a `description`, agent
parrots it" to "MCP hands over all the deterministic facts, agent does the deduction
and phrasing." **`where_is_user` is now the single point of connection** and returns one
rich snapshot: `place`/`confidence`/`source`, a `position` block (lat/lon, `accuracy_m`,
`precision` high/approximate/coarse, `age_s`, `freshness`, road/neighborhood/city), `motion`
+ `speed_kmh` + `heading` (bearing/cardinal), a recent `trail` (last ~12 fixes / 30 min for
trajectory + destination inference), the `wifi` anchor, and `recently_left`. `description`
stays as a deterministic baseline/floor, not a line to parrot. **`get_situation` embeds the
exact same object** as `current_location` (no more bespoke flat shape), and the old
**`get_current_location` tool was retired** — `where_is_user` is the only current-location call;
the dashboard map now reads its `position` block (consumer migrated, admin tool-list + design
docs updated).
**Enum unification:** one freshness vocabulary everywhere — `live`/`recent`/`stale`/`unknown`
(shared `Freshness`); the divergent `fresh`/`stale`/`very_stale` is gone from the agent surface
(resolver computes its usability booleans straight off age). New shared classifiers
`freshnessLabel` / `precisionLabel` / `speedKmh` in `describe.ts`. **Prompt:** "Location Awareness"
rewritten — deduce don't parrot (cycling vs driving from speed; "probably en route to school"
from heading+trail+calendar), hedge by confidence/precision, one fact per drive. Tests: shared
+3 (classifiers), awareness rich-snapshot/trail + source=none coverage (removed the legacy
get_current_location shape tests); shared 85, awareness 164, gateway 345 green; dashboard typechecks.

### Conversation authority unified on contact_settings; dead column retired (2026-06-06)
`list_conversations` reported `messaging_conversations.permission` — a column frozen at
its `'ignore'` default and never written since the contact_settings unification (gateway
migration 017), so `permission: 'agent'` always returned **0** even when chats were flipped
to agent in the dashboard. Authority truth lives in `contact_settings.permission` (written
by the dashboard Authority control + `set_contact_settings`, read by the permission checker).
Fixes: (1) the conversation repo's `list`/`get` now resolve permission from `contact_settings`
via a join (1:1 → linked KB person_id, group/unlinked → JID; `COALESCE(…, 'input')` default,
matching the checker) so the reported and filtered value reflect reality; (2) the
`update_conversation_permissions` tool now writes `contact_settings.permission` (Authority)
instead of `contact_settings.routing` — it had silently been a routing setter while its only
caller, the dashboard `/settings/messaging` page, sent `[ignore|input|agent]` permission
values, so that page's permission buttons never took effect; (3) removed the dead
`ConversationRepository.updatePermission` (zero callers); (4) **migration 005** drops
`messaging_conversations.permission` (017 already backfilled group permissions out of it).
Tests: +2 (update-permissions write path), messaging suite 70 pass.

### Useful location updates — rich descriptions + stops/pulse cadence (2026-06-05)
"You're in Haifa" was useless (true all day). Now the shared resolver builds a
`description` + `motion` (stationary/walking/driving) consumed identically by the
gateway write path and awareness read path: at a place → the place name; driving →
"driving on Route 6, heading south — near Kfar Saba" (road + bearing→cardinal +
nearby city); stopped at an unknown spot → "near Masada St, Haifa". **Tools:**
new `@ll5/shared/location/describe.ts` (`cardinal`, `motionState`,
`describeLocation`); reverse-geocode now parses `road` (Nominatim `road` / Google
`route`) and stores road/bearing on the location doc; `where_is_user` /
`get_current_location` / `get_situation` surface `description`+`motion`. **Cadence
(user choice "stops + pulse, prefer more on less"):** `runTransition` pushes on
place arrivals + stops (driving→stationary), suppresses town-by-town city spam
while driving, and emits one rich trip pulse at most every `TRIP_PULSE_MS` (12 min);
state carries `last_motion`/`last_pulse_at`. **Prompts:** new "Location Awareness"
section in claude-personality.md (always report `description`, never a bare city,
never narrate routine driving) + tightened `where_is_user` tool description.
Tests: shared +6, gateway transition +3 (suppress/pulse/stop). See
[LOCATION_SERVICE.md](design/LOCATION_SERVICE.md).

### Elasticsearch authentication enabled (2026-06-05)
ES ran unauthed (`xpack.security.enabled=false`) on the shared internal Docker net —
a latent risk, and an acute one once the agent got a browser (a prompt-injected page
could hit `http://elasticsearch:9200`). Enabled ES security (basic auth, no TLS —
internal-only + single-node). Every client now uses inline creds in `ELASTICSEARCH_URL`
= `http://elastic:${ELASTIC_PASSWORD}@elasticsearch:9200`: the `@elastic/elasticsearch`
clients (awareness, personal-knowledge, google, health, gateway) parse it with zero code
change; the dashboard's raw-`fetch` ES calls got a `lib/es.ts` helper (strips creds →
`Authorization: Basic`). `ELASTIC_PASSWORD` is a GitHub secret injected into the on-host
`.env` by the deploy job (findhub pattern); the `elastic` password was bootstrapped
post-deploy via `reset-password` to match. Brief all-MCP downtime during the cutover (depends_on gated on an unauthed ES healthcheck — now authenticated).
Rollback: `xpack.security.enabled=false` + redeploy. See
[DECISION-011](decisions/DECISION-011-elasticsearch-auth.md).

### Browser access via Playwright MCP (2026-06-04, deployed)
Gave the agent a real browser. New `browser` container in `docker/docker-compose.prod.yml`
running Microsoft's `mcr.microsoft.com/playwright/mcp` (headless Chromium, `--no-sandbox`,
`shm_size 1gb`), exposed over streamable-HTTP at `/mcp`. It has no built-in
auth, so it's fronted by a **Traefik basicAuth** middleware at `mcp-browser.noninoni.click`
(the password lives only in the agent's `BROWSER_MCP_BASIC` env, never in git; the apr1
hash is in the Traefik label). The agent (`ll5-run`) gets a `browser` server in `.mcp.json`
(headersHelper `get-browser-auth.sh`) + `mcp__browser__*` permission. Pairs with Anthropic
`web_search`/`web_fetch` for read-only tasks. See
[DECISION-010](decisions/DECISION-010-browser-access.md). **Hardened 2026-06-05:** SSRF —
`--blocked-origins` blocks the metadata IP + internal ll5 services (ES is unauthed on the
shared net, the acute risk) + `--block-service-workers`; **persistent login** — dropped
`--isolated`, `--user-data-dir` on a bind-mounted pre-chowned host dir
`/opt/ll5/browser-profile` so cookies/logins survive restarts. Residual: raw-IP internal
access (mitigate later via ES auth or a dedicated browser network).

### Location resolution consolidated into one canonical resolver (2026-06-04)
"Where is the user / what place" was computed two ways that disagreed: the gateway
write/transition path (`processors/location.ts`, GPS-only `deriveLabel`) drove the
`[Location]` pushes/system-messages, while the awareness read path
(`location-service.ts`, GPS+WiFi fusion) drove the agent tools — and the write path
ignored WiFi entirely. At home, GPS jitter at the 100 m radius edge flapped
Home↔"Zikhron Yaakov" every push (spamming notifications) even though the phone was
continuously on the home WiFi the read path knew about. **Fix:** new pure module
`packages/shared/src/location/` (constants + `haversineMeters` + `gateAccuracy`/
`detectDriftGlitch` + `resolveLocation`) is the single brain both paths now call.
`resolveLocation` = the 7-tier GPS+WiFi fusion **+ WiFi anchoring** (a confident
BSSID→place wins when GPS has no/stale match → stops the flapping) **+ departure
hysteresis** (a low-accuracy/stale fix can't flip you off a held place; only a
fresh good-accuracy "real departure" releases it). The gateway now reads the latest
WiFi at ingest + passes the prior label; awareness `LocationService` delegates to
the same function (read-path behaviour unchanged, 166 tests green). Added per-place
`radius_m` (default 100) on `ll5_knowledge_places` honored by `matchKnownPlace`, and
the `upsert_place` tool param, so a large home compound can widen its radius.
All thresholds single-sourced in shared. Tests: shared 74 (incl. new
`location-resolve.test.ts`), gateway 342 (incl. new `location-transition.test.ts`
proving no home flapping), awareness 166, personal-knowledge 85. See
[DECISION-009](decisions/DECISION-009-location-resolution-consolidation.md).
- **Follow-up fix (2026-06-04, post-deploy verification):** the first night's live
  data showed flapping persisted because (a) the WiFi anchor required the connect
  event `< 10min` old, but Android wifi heartbeats are sparse (~30–60min), so the
  anchor never engaged at night; and (b) hysteresis treated a 100m-accuracy fix
  (the actual jitter) as a "confident departure" (`<= LOW_ACCURACY_METERS`=100).
  Fixes: a CONNECTED wifi event now anchors for up to `WIFI_CONNECTED_ANCHOR_MS`=2h
  (a connect means you're on that network until a disconnect; heartbeats just
  refresh it), and a departure now requires `DEPARTURE_ACCURACY_M`=50m precision.
  +2 regression tests.

### Find Hub poller DISABLED (2026-06-03)
The findhub-poller was disabled because its periodic Find Hub `LocateTracker` requests (every `FINDHUB_POLL_INTERVAL_SEC`=900s) were causing tracked devices/tags to **ring**. Actions taken: stopped the running container on the box (`docker stop` + `docker update --restart=no` on `xkkcc0g4o48kkcows8488so4-findhub-poller-1`), commented the service out of `docker/docker-compose.prod.yml` (deploy uses `docker compose up -d` without `--remove-orphans`, so it won't be recreated), and removed `findhub-poller` from `build-and-push.yml` (PACKAGES build matrix + deploy pull loop). The awareness `tracked_devices` tools + dashboard page remain (read-only; they don't ring anything) but will go stale with no poller feeding them. **Re-enable:** uncomment the compose block + restore it in the workflow, but first raise `FINDHUB_POLL_INTERVAL_SEC` and/or narrow `FINDHUB_DEVICE_TYPES` so locate requests don't ring devices.

### Feature: Google Find Hub tracked-device location (2026-06-01, NOT deployed)
New capability to locate **things** (Bluetooth tags on keys/bag/car, ESP32 trackers) and **other devices** shared to the Google account (partner's phone, tablet) via Google's Find Hub (Find My Device) network — distinct from the user's own GPS, which already flows from the phone. Full vertical slice, no notifications in v1. See [docs/design/findhub.md](design/findhub.md) and [DECISION-008](decisions/DECISION-008-findhub-python-sidecar.md).
- **Sidecar** `packages/findhub-poller/` (Python — the stack's first) wraps [GoogleFindMyTools](https://github.com/leonboe1/GoogleFindMyTools) (pinned commit d46e952), polls every 15 min, POSTs `tracked_device` items to `/webhook` with the user's `ll5.<token>` Bearer. All unstable upstream calls isolated in `findhub_client.py`; explicit `User-Agent` set (Cloudflare 403s default Python UA). Auth = `Auth/secrets.json` minted once locally with Chrome, mounted into the Chrome-less container.
- **`findhub_client.py` matches the REAL upstream contract** (verified live 2026-06-01): upstream's `get_location_data_for_device` blocks forever (untimed `while result is None`) and only PRINTS the location, so the adapter instead drives the primitives — `request_device_list`/`get_canonic_ids` for the list; `FcmReceiver` + `create_location_request` + `nova_request` for a fix WITH a timeout (`FINDHUB_LOCATE_TIMEOUT_SEC`, default 30); and a vendored copy of the decrypt loop that RETURNS structured locations (reusing upstream crypto helpers). Per-report decrypt is defensive — a single bad report (e.g. the known phone own-report `InvalidTag`, upstream #22) is skipped, not fatal.
- **VERIFIED end-to-end against the live account (2026-06-01):** all 5 Bluetooth trackers locate + decrypt with good accuracy (20–34m); the POCO phone yields no fix (own-report `InvalidTag` — not the target). `secrets.json` fully populated (aas_token, fcm_credentials, shared_key, owner_key, username).
- **DEPLOYED (2026-06-01):** gateway + awareness redeployed via CI (merge `cff0602`); a live `get_tracked_devices` MCP read returned all 5 trackers with place-matching ("Home", "Rotem's Parents' House"), addresses, and freshness. The poller now runs as a **compose service** `findhub-poller` in `docker/docker-compose.prod.yml` — reaches the gateway over the INTERNAL network (`http://gateway:3000/webhook`) and receives the authenticated `secrets.json` as base64 via the `FINDHUB_SECRETS_B64` Coolify env var (written to disk at startup, since the host can't be SSH'd). CI `build-and-push.yml` builds the Python image (Node steps guarded off for `findhub-poller`; Dockerfile uses repo-root-relative COPY). Coolify env on the `ll5` service: `FINDHUB_WEBHOOK_TOKEN` (long-lived ll5 token), `FINDHUB_SECRETS_B64`, `FINDHUB_DEVICE_TYPES`. Deploy-script pull loop in `build-and-push.yml` now includes `findhub-poller` (first deploy auto-pulls via `docker compose up`, but `:latest` updates need the explicit pull). NOTE: Coolify's own service view of this CI-managed stack is stale/unreliable (it knows only the 4 services in its stored compose) — do NOT trigger a Coolify-side deploy (stale-compose + --remove-orphans footgun, per the 2026-05-18 incident); the repo `docker-compose.prod.yml` + CI deploy job is the source of truth.
- **Dashboard UI (2026-06-01):** new **Tracked Devices** page (`/tracked-devices`, under People & Places in nav) — reads the awareness `get_tracked_devices` MCP tool via `mcpCallList`, renders per-device cards (type icon, resolved place, address, accuracy, battery, freshness badge, "located"/"checked" ages, Google Maps link). Added a **Find Hub** toggle to Settings → Data Sources (`findhub` key; server-side source so it skips the Android device-sync, unlike phone-collected sources). `get_tracked_devices` now also returns `updated_at` + `since_update_minutes` (ingest time, distinct from network `last_seen`) so a reader can tell "stale because nobody saw it" from "stale because the poller stopped". Dashboard + awareness typecheck clean; awareness 166 tests pass.
- **Poller NOT pushing in prod yet (2026-06-01, investigating):** `get_tracked_devices` shows `since_update_minutes` stuck at my manual-push time (~14:20) across 3 deploys — the box poller has never pushed, almost certainly because the `FINDHUB_*` env vars set via the Coolify API didn't reach the on-host `.env` that `docker compose up` reads (→ empty `${FINDHUB_WEBHOOK_TOKEN}` → `exit(2)` crash-loop). Box SSH times out from the Mac and Coolify-side deploy is the stale-compose footgun, so added `.github/workflows/diagnose-findhub.yml` (manual `workflow_dispatch`, read-only: SSHes via the deploy key, dumps poller container state + logs + which `FINDHUB_*` keys exist in `.env` — names only) to diagnose via CI. **Diagnostic CONFIRMED it** (`.env` FINDHUB count = 0; container `Restarting (2)`; logs `Missing required environment variable: LL5_WEBHOOK_TOKEN`).
- **FIX (2026-06-01):** the deploy job now injects the poller secrets into the on-host `.env` itself (idempotent upsert) from **GitHub Actions secrets** `FINDHUB_WEBHOOK_TOKEN` / `FINDHUB_SECRETS_B64` / `FINDHUB_DEVICE_TYPES` — bypassing Coolify's broken `.env` sync. These GitHub secrets are now the source of truth for the poller (the Coolify-service env vars I set earlier are redundant/harmless). Verify post-deploy via `since_update_minutes` or the diagnostic workflow.
- **Gateway**: new `tracked_device` push item (`types/push-data.ts`), `processors/findhub.ts` (`processTrackedDevice` — reuses `reverseGeocode` + exported `matchKnownPlace`, upserts current-state by `${userId}:${deviceId}`, NOT through `processLocation`/the user GPS stream, no drift filtering), wired into `processItem` switch + `sourceMap` (`findhub` data-source key) + startup log.
- **Awareness MCP**: new shared index `ll5_awareness_tracked_devices` (geo_point, in `@ll5/shared` `AWARENESS_INDICES`), `repositories/.../tracked-device.repository.ts`, `tools/tracked-devices.ts` → `get_tracked_devices` + `where_is_device` (fuzzy name; collapse provenance to one `place`: saved-place > Google semantic > address > coords; report `freshness`/`age_minutes`).
- Shared built, gateway + awareness typecheck clean. Additive — no migration, no impact on existing clients.

### Fix: AgentOutputMonitor false "agent silent" alarms (2026-05-31)
The "LL5 agent silent — N scheduler triggers but no agent reply OR journal activity" FCM was firing repeatedly overnight on a perfectly healthy agent (it was journaling ~hourly the whole time). Root cause in `scheduler/agent-output-monitor.ts`: the journal-aware liveness check used the **same short window as the chat-silence threshold** (`silenceHours`, live value ~0.5h), but the agent's overnight journaling cadence is ~1h — so in the 30-min gaps between hourly journals the journal check found nothing → `journal_active_in_window:false` → it false-alarmed (escalating to `critical`) every ~hour. Fix: the journal-alive check now uses its **own generous window** `max(silenceHours, JOURNAL_ALIVE_FLOOR_HOURS=2h)`, so normal journaling reliably registers as alive while a genuinely dead agent (no chat AND no journal for 2h+ with triggers piling up) still trips the failsafe. +3 tests (no-alarm on 45-min journal; still-alarms on 3h-dead; organic-silence skip); gateway 345 tests, typecheck clean. (Context: yesterday's `AUTH_SECRET` incident genuinely silenced the agent for ~3h — those alerts were real — and the deploy-restart churn briefly reset the monitor's in-memory anti-flood cooldown; the overnight floods were this pre-existing window bug.)

### GPS-awareness Stage 4: stay-point (dwell) detection + visit/frequent-place tools (2026-05-30)
Stage 4 of the GPS-awareness effort (branch `feat/gps-stay-points`, stacked on Stage 1). Until now the system only recognized PRE-DEFINED places (a 100m geo-match against `ll5_knowledge_places`); raw GPS was never clustered into visits, so frequently-visited but unregistered locations were invisible. **G4 core:** new pure, fully-unit-tested clustering module `packages/awareness/src/services/stay-point-service.ts` — `detectStayPoints(points, params)` runs classic stay-point detection (a visit is a maximal run of consecutive points staying within `STAY_RADIUS_M`=150m of the run anchor for at least `MIN_DWELL_MS`=10min; a gap > `MAX_GAP_MS`=30min between consecutive points breaks the run), returns `Visit` objects `{centroid, start, end, duration_minutes, point_count, matched_place_id?, matched_place?}` with the dominant matched place propagated onto the visit; robust to empty/single-point/desc-sorted/identical-timestamp input. `groupVisitsIntoCandidates` greedily groups nearby visit centroids into frequent-place candidates. **A6 tool `query_visits`** (awareness MCP): given `from`/`to` (+optional `limit` and threshold overrides `stay_radius_m`/`min_dwell_minutes`/`max_gap_minutes`), fetches GPS history and returns visits (`centroid`, `start`/`end` + local, `duration_minutes`, `point_count`, `place_id`/`place_name`) — the "where did I spend time" answer. `query_location_history` is unchanged (still raw points). **G4 tool `suggest_frequent_places`**: over a longer window, clusters visits, groups nearby centroids across days, EXCLUDES anything already at a known place (dwell carried a `matched_place`, or centroid within 100m of an `ll5_knowledge_places` doc via the same `geo_distance` query pattern the place repo uses — ES client injected like `LocationService`), filters by `min_visits` (default 3), and returns unknown recurring spots `{centroid, visit_count, total_duration_minutes, first_seen, last_seen}` sorted by visit_count desc — lets the agent propose saving unnamed spots. Both tools registered via `tools/index.ts` (ES client now threaded into `registerLocationTools`). Awareness 162 tests pass (was 140, +22: 15 clustering unit tests + 7 tool tests); typecheck clean. Not deployed.

### GPS-awareness: get_situation now uses the fusion service (2026-05-30)
Stage 1 of the GPS-awareness fix (branch `fix/gps-agent-awareness`). The agent's one-call snapshot tool `get_situation` (awareness MCP) previously bypassed the GPS+wifi fusion layer and returned the raw last GPS point, so it disagreed with `where_is_user`/`get_current_location` and dropped wifi-resolved place/confidence/source/reasoning. **A1:** `get_situation` now calls `LocationService.getCurrentLocation()` and surfaces the fused result — keeps the legacy flat fields (lat/lon/accuracy/timestamp/freshness/place_name/place_type/address) for backward compat and adds `confidence`, `source`, `reasoning`, `wifi_place`, `recently_left`; `current_location` is null when fused source is `none`. `LocationService` is threaded into `registerSituationTools`. **A5:** `get_current_location`'s `fused` object now includes the `gps` block (parity with `where_is_user`). **A7:** `LocationService` adds an optional `recently_left` hint ({place_name, place_id, age_s}) on `CurrentLocation` — when GPS is not fresh and the latest wifi event is a recent (<10m) DISCONNECT whose BSSID maps to a known place, it's added as additive context and mentioned in `reasoning`; the chosen place/confidence/source decision is unchanged. Awareness 146 tests pass (was 140, +6); typecheck clean.
### GPS-awareness Stage 2 — gateway deviation/ingestion fixes (2026-05-30)
Branch `fix/gps-gateway-deviation` (not deployed). Eight gateway fixes to GPS ingestion + scheduler location-awareness:
- **G3** — `PushLocationItemSchema` now accepts optional `speed_mps` / `bearing_deg` / `altitude_m`; `processLocation` persists them (`speed`/`bearing`/`altitude`) into the `ll5_awareness_locations` doc. Shared `awareness.ts` index mapping gained `bearing`, `altitude`, `low_accuracy`.
- **G1/G2** — drift detection is now batch-aware and order-safe. `server.ts` sorts location items in a webhook batch by ascending timestamp (other item types keep original order; every result is written back at its ORIGINAL index, so `results` bookkeeping is unchanged). `processLocation` takes an optional `prevPoint` and RETURNS the stored point (or `null` if dropped) so the server loop chains the real in-batch predecessor instead of comparing every point against the stale ES latest. First item falls back to ES `getPreviousLocation`. Non-positive time deltas (out-of-order after sort / clock skew) skip the speed check but still store.
- **G6** — device speed used to keep legitimate fast travel: a point whose computed speed exceeds `IMPLAUSIBLE_SPEED_KMH` (150) is KEPT when device `speed_mps` confirms motion (> `DEVICE_STATIONARY_SPEED_KMH` 30 km/h and within `SPEED_AGREEMENT_RATIO` 0.5 of computed); dropped as a teleport glitch only when device speed is low/absent, or always when computed speed exceeds the absolute ceiling `ABSOLUTE_MAX_SPEED_KMH` (1000 km/h).
- **G9** — low-accuracy no longer loses location: > `LOW_ACCURACY_METERS` (100) is STORED flagged `low_accuracy:true` (down-weightable downstream) instead of dropped; only > `MAX_ACCURACY_METERS` (2000) is dropped as garbage. Glitch/drift points are still dropped (not stored).
- **G5** — new in-process per-key async mutex `utils/key-mutex.ts` (`gatewayKeyMutex`) serializes the per-user transition state read-modify-write (keyed `location-state:${userId}`) and the per-(user::bssid) network upsert (keyed `network-obs:${docId}`), fixing double-fired transition pushes / lost observation counts under concurrent webhooks.
- **G8** — `wifi.ts` caps `place_observations` at `MAX_PLACE_OBSERVATIONS` (20) by count desc then last_seen desc, so promiscuous BSSIDs can't bloat the doc (debug log on prune).
- **A2/A3** — new shared helper `scheduler/location-state.ts` (`getCurrentPlace` / `buildLocationLine`) reads the `ll5_awareness_location_state` doc; heartbeat `[Time Check]` and morning `[Morning Briefing]` now include a `Location: at/in <label> (as of <local time>)` line (omitted when absent or > 6h stale). `DailyReviewScheduler` gained an optional `es` ctor arg.
- **A4** — transition agent-context system message now appends a signal-quality qualifier (`[place match]` for a ≤100m known-place match vs `[city-level]` for a geocoded city); user-facing FCM wording unchanged.
- Tests: +5 new files, 36 new tests (key-mutex 5, location-processor 11, wifi cap 2, location-state helper 9, webhook ordering 2 — though some files bundle related cases). Gateway suite 339 tests pass; `tsc --noEmit` clean.
### GPS-cleanup geo-bounds made opt-in (gap G7) (2026-05-30)
Branch `fix/gps-cleanup-tool`. The admin GPS-cleanup tool hard-coded an Israel bounding box for its "Outside Israel" criterion, so every legitimate point was flagged the moment the user traveled abroad. Fix: extracted the box into `DEFAULT_GEO_BOUNDS` + a pure `isOutOfBounds()` predicate in a new testable module `packages/dashboard/src/app/(admin)/admin/gps-cleanup/gps-bounds.ts`. `scanBadGpsPoints(timeRange, geoFilter?)` now takes an optional `GeoFilterOptions { enabled; bounds? }` that defaults to **disabled** — when off, no point is ever flagged out-of-bounds (safe to run while/after travel); when on, `bounds` defaults to the Israel box but a custom box may be passed. `scanAndDelete(timeRange, criteria, geoBounds?)` only enables the geo filter when `out_of_israel` is among the requested criteria. UI wired: `/admin/gps-cleanup` gains an "Enable geo-boundary filter" toggle + min/max lat/lon inputs (pre-filled with the defaults), the "Outside bounds" card is disabled/greyed when the filter is off, and the criterion is no longer selected by default. Scan/scanAndDelete now log a one-line summary (per-criterion counts + whether the geo filter was active) via `console`, matching the admin log-explorer convention. +9 unit tests on the bounds helper (in-bounds not flagged, abroad flagged when active, abroad NOT flagged when disabled, inclusive edges, custom box). dashboard 61 tests pass; `tsc --noEmit` clean. Not deployed.
Stage 1 of the GPS-awareness fix (branch `fix/gps-agent-awareness`). The agent's one-call snapshot tool `get_situation` (awareness MCP) previously bypassed the GPS+wifi fusion layer and returned the raw last GPS point, so it disagreed with `where_is_user`/`get_current_location` and dropped wifi-resolved place/confidence/source/reasoning. **A1:** `get_situation` now calls `LocationService.getCurrentLocation()` and surfaces the fused result — keeps the legacy flat fields (lat/lon/accuracy/timestamp/freshness/place_name/place_type/address) for backward compat and adds `confidence`, `source`, `reasoning`, `wifi_place`, `recently_left`; `current_location` is null when fused source is `none`. `LocationService` is threaded into `registerSituationTools`. **A5:** `get_current_location`'s `fused` object now includes the `gps` block (parity with `where_is_user`). **A7:** `LocationService` adds an optional `recently_left` hint ({place_name, place_id, age_s}) on `CurrentLocation` — when GPS is not fresh and the latest wifi event is a recent (<10m) DISCONNECT whose BSSID maps to a known place, it's added as additive context and mentioned in `reasoning`; the chosen place/confidence/source decision is unchanged. Awareness 140 tests pass (was 135, +5); typecheck clean.

### BYO-agent tenant platform — design + Phase 1 (identity & invite) (2026-05-30)
New direction for multi-tenancy: **LL5 is the platform; each tenant brings their own LLM account.** LL5 provides data + proactive backend + dashboard + agent persona/runtime shell; each user supplies their own Claude credential (Anthropic API key in the UI for now; OAuth subscription-token path exists in the backend, dormant) and LL5 runs a per-user Claude Code container scoped to their `user_id`. This dissolves the deferred "agent pool" cost problem (LL5 never pays for LLM tokens). Locked: LL5-hosted per-user container runtime, invite-only signup, isolated-individual tenants. Design in `docs/design/byo-agent-tenant-platform.md`; rationale in `DECISION-007`; old `user-management.md` Phase 6 superseded. **Phase 1 implemented** (branch `feat/tenant-p1-identity`, not yet deployed): migration `028_identity_and_invites.sql` (auth_users +email/password_hash/email_verified with a `lower(email)` unique index; new `invites` + `auth_tokens` tables); gateway adds email+password login (existing username+PIN path preserved), `POST /auth/forgot` + `/auth/reset` (single-use, no enumeration), and an invites router (`POST/GET/DELETE /admin/invites` admin-only, public `GET /invites/validate` + `POST /invites/accept` that creates the user with `email_verified` + onboarding seed transactionally). Email is a pluggable `EmailSender` (default logs the link + the create-invite response returns the `accept_url`; SMTP is a follow-up). Dashboard: email/password login (username+PIN toggle retained), public `/accept-invite` `/forgot` `/reset` pages (middleware allowlisted), and an admin `/admin/invites` page (create/list/revoke + copyable accept link). +26 tests (gateway 242, dashboard 11); typecheck clean across all packages. Remaining phases: P2 unified onboarding wizard, P3 agent connection plane, P4 runtime orchestrator, P5 lifecycle/ops. (ToS gate resolved: hosted runtimes use the user's **API key** — unambiguous — so P4 is unblocked; the OAuth subscription path stays dormant.) **W1 added** (same branch): a **superadmin** role (`user < admin < superadmin`; existing admin promoted via migration `029`; `requireSuperadmin` gate; only a superadmin may assign admin/superadmin; `@ll5/shared` `TokenClaims.role` now includes superadmin), and a superadmin **tenant-management console** — gateway `GET /admin/tenants[/:id]` returns each tenant enriched with onboarding %, channel-connected flags (google/whatsapp/health), and last-active; dashboard `/admin/tenants` page lists tenants with role/onboarding/channel/last-active + enable/disable + invite/resend. Gateway 262 / dashboard 19 / shared 50 tests; typecheck clean. **W2 added**: unified onboarding wizard — gateway `GET /me/onboarding` (self-scoped: onboarding steps + channel flags + phone-linked + profile, reusing the tenant enrichment); dashboard `/onboarding` rebuilt as a resumable 7-step flow (profile, notifications, Google, WhatsApp/Health, **live phone-link verification**, agent placeholder, done) driven off `/me/onboarding`. Gateway 270 / dashboard 31 tests. **W3 added**: agent connection plane — gateway migration `030` (`agent_credentials` revocable, `agent_llm_credentials` AES-256-GCM-encrypted), self-scoped `/me/agent/connection` (mints a 90-day token + returns a Claude Code `.mcp.json` for the 6 MCPs, once), credential list/revoke, `/me/agent/llm-credential` PUT/GET/DELETE (write-only API key, status=last4), and `/auth/refresh` now denies revoked agent credentials; dashboard `/settings/agent` (API key + connection kit + revoke) + onboarding agent step wired. Security: API key encrypted at rest, never returned/logged; **hard requirement recorded** — the orchestrator must inject creds via a non-`ps`-visible channel (found the current agent exposes its token in `ps`). Gateway 287 / dashboard 42 tests. **W4 added** (P4+P5): new `packages/agent-orchestrator` service — a Docker-API control plane that provisions per-user Claude Code containers (DockerRuntime over the docker socket via node:http; MockRuntime for tests), decrypts the user’s API key, and injects creds via a **0600 env-file mounted read-only** (never argv/`-e` → not visible in `ps`/`inspect`), with capacity cap + heartbeat reconcile. Gateway migration `031` (`agent_runtimes`), orchestrator client + self/superadmin runtime endpoints (`/me/agent/provision|stop|runtime|heartbeat`, `/admin/tenants/:id/agent/*`), tenant/onboarding enrichment with runtime status, and **P5 lifecycle hooks** (disable-user and revoke-credential → stop the runtime). Dashboard `/settings/agent` runtime panel (provision/stop, gated on API key, live poll) + tenant-console Agent column/controls. **847 tests pass; typecheck clean across 12 packages.** All on branch `feat/tenant-p1-identity`, **not deployed** — going live needs the ll5-run base-image companion change (read creds from the mounted env-file; heartbeat), a dedicated agent host for the orchestrator, an SMTP provider, and the deploy. See `docs/design/byo-agent-tenant-platform.md` §8. **W5 (go-live prep)**: real SMTP `EmailSender` (nodemailer; `SMTP_*` env; falls back to logging the link when unset); and a **separate `ll5-agent-tenant` image** (`docker/agent-runtime/`, built FROM the existing admin image which stays untouched) whose entrypoint injects per-tenant creds from a mounted 0600 env-file, runs claude with the agent token + the tenant's `ANTHROPIC_API_KEY`, and heartbeats — orchestrator `AGENT_IMAGE` defaults to it. Built manually via the `build-agent-tenant` workflow; image verification + production cutover reserved for the operator. 857 tests pass. **SMTP now wired live via Brevo** (gateway Coolify env: `smtp-relay.brevo.com:587`, from `LL5 <arnonwatch@gmail.com>`) — invites/reset send real email. Deploy is via `git push` (CI scp's the repo compose); a Coolify-MCP deploy reverts the host compose to a stale stored copy (it dropped the gateway SMTP lines — re-applied via CI).

### Code-quality / bug review batch — 22 fixes across 7 packages (2026-05-29)
A full-codebase correctness review (branch `fix/review-batch-2026-05-29`) found and fixed 22 bugs, TDD with a genuine RED captured before every source edit. Four were verified against **live production ES** before fixing: Garmin `active_seconds` was `0` on every daily-stats doc (operator-precedence `??`/`?:` bug), ~437 calendar events had `location == title` or `"(no title)"` (enrichment wrote the old title into `location` + the 30-min sync did a destructive full re-index that also reset `created_at`), 2 stress docs were orphaned with no `user_id` (invisible to scoped reads), and Google was the #1 error service from discarded rotated refresh tokens (18 invalid_grant lines). Also fixed: gtd `deleteAction` always returned false (double-DELETE), `updateAction` wiped `completed_at` on on_hold/dropped, Telegram `read_messages` misused `getUpdates`, messaging `bulkUpsert` crashed (PG 21000) on intra-batch duplicate JIDs, Evolution `connectionState` swallowed transient errors, SSE `/listen` timer/PG leak, `/availability/check` no client-abort, login rate-limit key bypass, `PUT /contact-settings` partial-update reset, API-key timing side-channel, and non-comparable cross-entity search scores. A class of **multi-tenancy by-id scoping violations** (gateway `/journal`,`/sessions/:id`,`/media/:id/links`, whatsapp-webhook lookups; awareness location-delete / `resolve_journal` / `link_media`; google calendar doc id) were closed with two-user tests and the new convention: scope by `user_id`, ownership-miss → 404 (not 403), and a `warn cross_user_access_denied` log. Every fixed path now emits a deterministic structured log (no silent errors). A follow-up **cross-tenant contamination audit** then enumerated every ES/SQL data-access point across all packages and closed **6 more vectors** (Evolution-cred read without user_id, unsalted calendar `phoneEventId`, unsalted health activity doc id, `getMessageCountToday` scoping, calendar-event upsert owner-verify, BSSID-place recheck) — root cause for the id ones recorded as DECISION-006 (deterministic ES doc ids must embed user_id). 694 tests pass (was ~611, +83); typecheck clean across all 11 packages. Decisions recorded in `docs/decisions/DECISION-001..006`; full bug→fix→RED/GREEN evidence + the audit + synthetic-tenant verification in `docs/reviews/2026-05-29/`. Three guarded data-repair scripts authored (calendar locations, orphan stress docs, legacy calendar ids) — dry-run default.

**Deployed to prod + verified (2026-05-29 PM).** All builds + deploy green; containers healthy. Live two-tenant probe (synthetic tenants seeded into prod ES, then cleaned up) confirmed isolation: tenant B got `entries:[]` on `/journal`, `404` on `/sessions/:id` and `PATCH /journal/:id`, and tenant A's entry was untouched. Prod data repairs applied: **R1** cleared 437 bogus calendar locations, **R2** backfilled the 2 orphan stress docs (both verify to 0 remaining). Follow-up consistency fix found during verification: the two calendar-event writers disagreed on the doc-id scheme (gateway `scheduler/calendar-sync.ts` still wrote the legacy `google-${id}` while the google MCP repo — workstream D — writes the scoped `${userId}::google-${id}`), which would duplicate agent-created events; gateway sync now writes the same scoped id (DECISION-006). **R3** migrated the 1748 legacy-id calendar docs to the scoped scheme (indexed 1748 scoped + deleted 1748 legacy, 0 errors; final legacy=0, scoped=1748, no duplicates). See `docs/reviews/2026-05-29/verification.md`.

### Fix: outbound WhatsApp now stores the contact name (2026-05-27)
Your own sent WhatsApp messages were captured (`from_me:true`, full `content`) but with `conversation_name: null` — the ES doc write used `conversationName ?? groupName` and ignored the already-resolved `contactDisplayName` (from the `messaging_contacts` lookup that runs for any 1:1). So outbound landed keyed only by raw JID, and the agent's name/person-based thread lookups (`read_messages`, `get_person`) couldn't correlate it → it thought it "didn't see" sent messages and re-nagged about handled items. Fix in `processors/whatsapp-webhook.ts`: `conversation_name` now falls back to `contactDisplayName` (1:1) so outbound is queryable by contact name like inbound; `person_id` was already attached. +6 tests; gateway 194 tests pass.

### Phone low-battery alert + ES memory bump (2026-05-27)
Gateway proactively alerts on a discharging phone — escalating thresholds **20% (notify) → 10% (notify) → 5% (alert)**, each once per discharge, reset on charge. Event-driven from `phone_status` pushes: `processors/battery-alert.ts` (pure `decideBatteryAlert(prevState, pct, isCharging)` + in-memory per-user state) wired into `processPhoneStatus` (now takes the pg Pool) → `insertSystemMessage`. +8 unit tests; gateway 189 tests pass. Also bumped **Elasticsearch 1g heap/1.5G → 2g heap / 4G limit** (`docker/docker-compose.prod.yml`) to stop the recurring ES OOM/restart cascades that flag gateway+knowledge+awareness+health as "down" (their /health probes hit ES). See `docs/HANDOFF.md` Databases.

### Agent MCP autoheal + CI deploy via tailnet (2026-05-25, ll5-run)
The server agent lost all 6 remote MCPs when the Coolify proxy dropped the app network (Claude Code marks HTTP MCPs failed and never retries after recovery → manual `/mcp` reconnect × 6). Fixed in `ll5-run` (`0862c30`): `ll5-server` is now a **supervisor loop** (not `exec claude`) so the tmux session/container survive a claude restart; a new in-container watcher `scripts/mcp-autoheal-server.sh` (started by `docker-entrypoint.sh`) polls the 6 `/health` endpoints every 60s and, on the **recovery edge** (down→up — the reliable trigger, since the channel MCP's probe only proves endpoints reachable, not that claude reconnected), touches a resume-flag + kills claude so the loop relaunches `claude --continue` (same conversation, fresh MCP clients). 10-min anti-flap.

Separately, the `ll5-run` CI **deploy** step was timing out (`curl: (28)`) because `cp.arnonzamir.co.il` (Coolify API) is now tailnet-only. Fixed (`a632bfa`): the deploy job runs `tailscale/github-action@v3` with repo secret `TS_AUTHKEY` before the deploy curl. **⚠️ `TS_AUTHKEY` is an auth key → expires ~2026-08-23; rotate before then** (see `docs/HANDOFF.md` → Agent deploy). Manual fallback: Coolify MCP `deploy {tag_or_uuid: js8owk0g0cgog800ckc8ww0s, force: true}`. Both pipelines verified green end-to-end.

### health: reconnect_health_source + Garmin device name/last-sync (2026-05-24)
Added **`reconnect_health_source`** (health MCP, agent-accessible): re-establishes a source connection from the user's already-saved encrypted credentials — no password through chat — to recover a broken/expired session (e.g. Garmin "Unsupported state"); fails clearly if nothing is stored (→ dashboard connect). Reuses the same decrypt→adapter.connect path sync already runs. 44 tests pass.

Investigated adding watch battery to daily stats. **Conclusion (live, vívoactive 5): Garmin's web API does NOT expose watch battery %.** Probed `deviceregistration/devices`, `/device-service/deviceservice/mylastused`, and `/web-gateway/device-info/primary-training-device` via the `apiGet` escape hatch — all carry only capability flags (`bodyBatteryCapable`, `batteryStatusCapable:false`), no battery value; the device's nested `deviceStatus` is just `"active"`. (Battery shows in the Garmin *mobile* app via BLE, not the queryable web API — matches garth/python-garminconnect having no battery method.) Final shape: `get_daily_stats.device = { name, lastSync }` from `mylastused` (`GarminClient.getDeviceLastUsed()` → `garmin-normalizer.extractDeviceStatus()`; stored as `device_name`/`device_last_sync` in `ll5_health_daily_stats`) — the battery fields were removed rather than ship a perpetually-null value. Body Battery (the energy metric) was already captured. Health 44 tests pass; typecheck clean.

### CLI fidelity: prose IS the answer + mirror true-backstop (2026-05-24)
The CLI (native Claude Code TUI) shows the agent's turn-final prose, not the folded `push_to_user` call — so when the agent pushed the answer then ended with a *summary* ("Gave him the rundown"), the CLI showed the summary while web/Android showed the real answer bubble. Fixed two ways: (1) `ll5-run/decide_mirror.py` now detects when the agent delivered via push_to_user/reply (with text) in the current turn and **skips mirroring** — a true backstop, so the turn prose can be the full answer for the CLI with zero double-post risk (no longer relies on byte-identical dedup); +6 unit tests, 20/20. (2) Persona one-voice rule (+ this character-refresh habit 3): your prose IS the answer (the CLI shows it), never a summary; deliver the same message via push/reply for web/Android + phone level. `ll5-run 526cd81`.

### Fix: deliver answers via explicit push/reply — mirroring is backstop only (2026-05-24)
Regression from the first ONE VOICE pass: telling the agent "let your first-person prose be the answer (mirroring delivers it)" made it stop calling `reply`/`push_to_user` and rely on `stop-mirror.sh`. That hook posts the transcript's **global last assistant line**, so under queued/burst messages it delivered the *previous* turn's answer to web/android and dropped the real one (confirmed in `~/.ll5/mirror-hooks.log`: the "Check emails" turn mirrored the earlier "Not sure what you're pointing at" text; the email answer never posted — CLI was correct). Fix in both the persona (`ll5-run/CLAUDE.md` `0e90f76`) and the gateway character-refresh habit (3): answers go through `push_to_user`/`reply` **every time** (reliable, in-order); mirroring is an explicit backstop only; CLI prose matches the pushed text so the mirror dedups it. (Deeper follow-up: `stop-mirror` `last_text` should be paired to the turn, not transcript-global — first eval/test target.) Gateway 181 tests pass.

### character-refresh: ONE VOICE re-anchor (no third-person recaps) (2026-05-24)
With `LL5_MIRROR=1` the Stop hook mirrors turn-final prose to the unified thread (dedup is text-identical only). The agent had drifted into writing a third-person recap as its turn output ("Made the sleep nudge explicit", "Confirmed Termius") while the real first-person answer went via the channel tool — so the CLI viewport showed a stage-direction instead of the message, and a divergent recap risked double-posting to the phone. Fixed in the persona (`ll5-run/CLAUDE.md` `1d324ad`: one-voice rule) and now also folded into the gateway's 4-hourly **character-refresh** nudge as habit (3) ONE VOICE so it re-anchors mid-session (alongside narrate + always-reply). Gateway 181 tests pass, typecheck clean.

### Scheduler UI: surface previously-hidden proactivity knobs + seconds-granular response watchdog (2026-05-23)
The gateway honors ~30 `settings.scheduler.*` keys (each `s('key', default)`), but the Scheduler settings page exposed only 16 — the rest silently used code defaults with no UI. Audit also confirmed every other top-level `user_settings` key is covered by a page (timezone/work_week/self_names → Profile; data_sources → Data Sources; notification quiet-hours → Notification Levels), except `active_escalations` which is runtime state, not config. Surfaced the user-facing subset on the Scheduler page: **Proactive Output** (agent_output_minutes / _min_triggers / _silence_hours [fractional, step 0.5] / _lookback_hours) and **Narrative Consolidation** (enabled toggle + run-at hour). Also converted the response watchdog from minutes to **seconds**: `ResponseTimeoutConfig.timeoutMinutes`→`timeoutSeconds`, SQL `make_interval(mins:=)`→`make_interval(secs:=)`, gateway reads `response_timeout_seconds` (falls back to legacy `response_timeout_minutes`×60, then 120s) — the watchdog gates on ~15s narration so minute-granularity was too coarse. New `ToggleField` (Checkbox) + `NumberField` float support in the view; `SchedulerSettings` now mixes number+boolean. Gateway 181 tests pass; gateway+dashboard typecheck clean.

### Agent can read/write its global settings — get_user_settings / set_user_settings (2026-05-23, ll5-run)
The agent had no tool for the global settings store (active/quiet hours, data-source toggles, notification levels, self_names) — only get_profile (timezone) and per-contact get_contact_settings. The channel MCP already fetched `/user-settings` internally but surfaced only `work_schedule` via get_current_time. Added `get_user_settings` (full settings object, optional `fresh` cache-bypass) and `set_user_settings` (deep-merge PUT, refreshes cache) to `ll5-run/channel/ll5-channel.mjs`. Goes live on the next agent channel-MCP restart (auto-deploy on push to ll5-run main).

### Web chat: agent bubble + left-aligned compact groups (2026-05-23)
Two visual regressions on the full-screen `/chat` stream. (1) Assistant messages had lost their speech bubble — the `unboxed` variant (`message-bubble.tsx`) rendered the agent's text as flush prose next to the ✦ coach dot. Restored a bubble: the content block is now a left-aligned, content-hugging speech bubble (`w-fit rounded-2xl rounded-bl-sm bg-gray-100 px-4 py-2.5`), keeping the ✦ gutter dot. (2) The collapsible "N system events · time" bands (`CompactGroup`) were center-aligned — the label sat between two `flex-1 border-t` rules. Dropped the leading rule (and added `text-left`) so the chevron+label start at the left margin with a single trailing rule. Dashboard typecheck clean.

### Fix: google/calendar MCP missing ELASTICSEARCH_URL (2026-05-23)
The calendar MCP reported "no Elasticsearch" / `ES not configured`: the `google` service in `docker-compose.prod.yml` never set `ELASTICSEARCH_URL` (every other ES-using service — personal-knowledge, awareness, health, gateway — does). With it null, `google/src/server.ts` runs `esClient = null`, logs "ELASTICSEARCH_URL not set — calendar reads will fall back to live Google API", and the ES-backed calendar tool returns `"ES not configured"` (`calendar.ts:603`); calendar reads hit the live Google API every time instead of the cached `ll5_awareness_calendar` ES index. Added `ELASTICSEARCH_URL: http://elasticsearch:9200` + a `depends_on: elasticsearch (service_healthy)` to the google service. Config-only; ships via the compose scp on deploy. (Google OAuth itself was fine — verified connected, live `/api/events` → 200.)

### character-refresh re-anchors narrate + always-reply (2026-05-23)
Two behaviors regressed after session-mirroring went live (the "you don't have to call reply just to be seen" framing): the agent stopped narrating multi-step work (~11/day → ~1/day) and stopped confirming completion of direct requests (did the work + journaled, no reply). Fixed in the agent persona (`ll5-run` CLAUDE.md), but CLAUDE.md only loads at session start — so also folded both into the gateway's 4-hourly **character-refresh** nudge (`scheduler/character-refresh.ts`) which re-asserts mid-session: (1) narrate your reasoning during multi-step work — activity markers are mechanical echoes, not narration; (2) always reply with a one-line confirmation when a direct request is done — a journal/update_*/marker is not a reply. Gateway typecheck + tests pass.

### narrate (thinking) rows break out of the folded tool-call group (2026-05-23)
The agent's `narrate` output (chat row `metadata.kind="thinking"`) posts with `display_compact`, so the render grouping folded it *into* the compact tool-call activity-marker group — visually swallowed (on the dashboard's collapsible "N system events" band it was even hidden behind the fold). Fixed in all three chat surfaces: `lib/chat/format.ts:buildRenderItems` (+ `message-stream.tsx`), `chat-widget.tsx` (dashboard tile), and Android `ChatScreen.kt` — a thinking row is now its own standalone render item that's never folded in, and emitting it ends the open compact group, so it cuts the block (tool calls above, narration line, tool calls below). The reflected `narrate:` tool-call marker still shows in the group — only the narration *output* is lifted out. Dashboard typechecks; Android builds. (Separately diagnosed: narrate usage cratered after the activity-marker hook went live 2026-05-22 — guidance fix TBD.)

### Public image uploads — shareable links (2026-05-23)
`/uploads/*` requires the LL5 token (per-file ownership), so those links only work inside authenticated clients. Added a public path so the agent can share an openable image link: `POST /chat/upload?public=1` stores the file under a crypto-random (unguessable) name in `/app/public-uploads` with the extension forced from the allowlisted mime, and returns `public_url`. New unauthenticated `/public/*` static route (`uploads-route.ts:createPublicUploadsRouter`, mounted before any auth in `server.ts`) serves it with `X-Content-Type-Options: nosniff`, no index, dotfile-deny. Dockerfile creates `/app/public-uploads` (app-owned). Pairs with the agent-box rasterizer (ll5-run): generate → `rsvg-convert` to PNG → upload `?public=1` → share `public_url`. Durability matches `/uploads` (no volume yet). Gateway 181 tests pass.

### Self-name outbound detection for phone-mirrored messages (2026-05-23)
The Android Slack reader can flag the user's own 1:1 DM replies (peer-name heuristic) but can't tell in **channels** read off-screen. Added a server-side backstop: `user_settings.self_names` (JSON array of the user's display names). `gateway/src/utils/self-names.ts` reads it (cached 60s, like `data-source-config.ts`); `processors/message.ts` now sets `from_me=true` when the resolved author matches a self-name (and nulls `person_id` so the message isn't linked to the user as a contact). Covers Slack channels + any phone-mirrored app. Editable in the dashboard **Profile → "Your Names (outbound detection)"** (comma-separated, saved to `user_settings` via the existing `/user-settings` PUT). Seeded `["Arnon Zamir","Arnon"]` for the live user. Gateway 181 tests pass; dashboard typechecks.

### Fix: gtd `check_messages`/`send_message` "fetch failed" — missing GATEWAY_URL (2026-05-22)
The agent's channel bridge (`check_messages` / `send_message` / `list_conversations`, which live on the **gtd** MCP in `tools/chat.ts`) was throwing "fetch failed" — a connection-level error, not an HTTP status — so inbound web/Telegram/WhatsApp messages couldn't be pulled and replies couldn't be sent. Root cause: the `gtd` service in `docker/docker-compose.prod.yml` had **no `GATEWAY_URL`** env, so `gtd/src/utils/env.ts` fell back to `http://localhost:3006`; the gtd container listens on 3000 and isn't the gateway, so every chat fetch connection-refused. The token the chat tools hand-roll is fine (`validateToken` only checks the HMAC over the payload + reads `uid`). Fix: set `GATEWAY_URL: http://gateway:3000` on the gtd service (the internal address the dashboard already uses). Config-only; ships via the compose scp on deploy. GTD MCP itself was always healthy — only its gateway-calling chat tools were affected.

### Narrative consolidation ON by default (2026-05-22)
Flipped the `narrative-consolidation` scheduler from default-OFF to **default-ON** (`scheduler/index.ts`: `narrative_consolidation_enabled ?? true`). It now fires daily (~3am, after journal consolidation) nudging the agent to refresh any narrative with ≥5 new observations since `last_consolidated_at`. This closes the loop with the strengthened journaling: the agent records observations constantly *and* now distills them into current summaries on a schedule, instead of leaving raw observations to pile up until a manual `/review`. A per-user `narrative_consolidation_enabled=false` still disables it (nullish-coalesce, so explicit false wins).

### Strengthened journaling/narrative instinct — skip is the exception (2026-05-22)
The agent was deciding to skip journaling/observing too readily. Tightened the guidance on both the deployed side and the agent persona so **writing is the default and skipping is a rare, logged exception**. Deployed (this repo): `write_journal` description now says "Default to writing … skip only a purely mechanical exchange that reveals nothing. When in doubt, write."; `note_observation` adds "Default to noting: if you can name a person, place, group, topic, mood, preference, or plan, record it rather than skipping"; the 4-hourly **character-refresh** nudge now reminds the Executor "Record as you go: every meaningful event leaves a journal entry or a note_observation — writing is the default, skipping is the rare exception you log a reason for." Agent persona (`ll5-run/CLAUDE.md`, separate repo): the Default-write rule reframes skip from "a third equal option" to "a rare exception" with a litmus test (if you can name an entity/mood/decision, it's a `note_observation`, not a skip) and a "when in doubt, write"; the "don't journal routine Q&A" line is narrowed to *purely mechanical* exchanges, with mid-Q&A world-detail still captured. Typecheck clean; tests pass (gateway 181, personal-knowledge 82, awareness 118).

### 1:1 conversations include pictures by default (2026-05-22)
Direct (1:1) chats now default to **routing=batch** (already the effective default — a no-match falls through to batch review) **and download_media=ON**. Groups stay opt-in (default off). `ContactRoutingResolver.shouldDownloadMedia` returns `true` for the 1:1/person path when there's no explicit row (and honors an explicit `download_media=false` to disable). Migration `027_oneonone_media_default.sql` flips existing `target_type='person'` rows from the implicit `false` (set by the dashboard default or the 026 sender migration — none were ever explicitly ON) to `true`, so existing direct chats also pull pictures. `get_contact_settings` reports the target-type-aware default. Gateway 181 / messaging 59 tests pass.

### Unified communication settings — dropped notification_rules (2026-05-22)
Collapsed the dual permission/routing system into a single source of truth: **`contact_settings` is now the only home for per-contact/per-chat routing (Delivery), permission (Authority), and `download_media`**, and the legacy `notification_rules` table is gone. Migration `026_drop_notification_rules.sql`: (A) idempotently re-backfills `conversation` rules into `contact_settings` (catches rows the messaging MCP wrote after 017), (B) best-effort migrates the 54 name-keyed `sender` rules into per-person `contact_settings` by resolving the display-name → `person_id` via `messaging_contacts` (unmatched bots/Slack composites are dropped — they can't be a person row), (C) `DROP TABLE notification_rules`. The **keyword-rule feature is removed entirely** (12 rules) along with the dead rule types (`app`/`app_direct`/`app_group`/`group`/`wildcard` — read but never created). Code: the gateway matcher `NotificationRuleMatcher` (`processors/notification-rules.ts`) became `ContactRoutingResolver` (`processors/contact-routing.ts`) — no rule cache, resolves routing/media purely from `contact_settings`; the messaging `update_conversation_permissions` tool now writes `contact_settings` (group→JID, 1:1→person_id) and audits as `entity_type:'contact_settings'` so the agent's writes land in the **same audit stream** as the dashboard's (closes the split-audit gap); `permission-checker.ts` dropped its `notification_rules` fallback; gateway `/notification-rules` CRUD endpoints, the awareness `*_notification_rule` MCP tools, and the orphaned `/settings/notifications` dashboard page (People/Conversations/Keywords tabs) are deleted; `export.ts` now exports `contact_settings`. The agent gets two new messaging MCP tools — **`get_contact_settings`** (read one contact/chat by person_id or platform+conversation_id, or list all configured) and **`set_contact_settings`** (change any of routing/permission/download_media; only passed fields change) — so the agent can manage Authority/Delivery/media per contact, not just routing via `update_conversation_permissions`. Both resolve a 1:1 chat to its linked person target and audit as `entity_type:'contact_settings'`. Typecheck clean across gateway/messaging/awareness/dashboard; tests pass (gateway 179, messaging 59, awareness 118).

### GHCR credential clobber — durable fix + runbook (2026-05-22)
Captured the full learning in `docs/runbooks/ghcr-shared-credential.md` (symptom, root cause, durable fix, emergency recovery, token-type diagnostics) so this stops being rediscovered. Verified the fix live: after the deploy, the host `/root/.docker/config.json` now holds a `ghp_` PAT (len 40), not the ephemeral `ghs_` token. Root-caused the recurring `denied` GHCR outage that kept breaking deploys. The ll5-main deploy step (`.github/workflows/build-and-push.yml` "Deploy to server") logged into the host's GHCR with `secrets.GITHUB_TOKEN` — an ephemeral `ghs_` Actions token (1h expiry). Because `/root/.docker/config.json` is SHARED by every Coolify app on the box, each ll5-main deploy overwrote the credential with a token that died an hour later, so the next pull by ll5-agent/ll5-run/claude-box failed `denied`. Manual PAT re-logins only lasted until the next ll5-main deploy. Fix: pin that login to the existing non-expiring `secrets.GHCR_READ_PAT` (read:packages) and `-u arnonzamir`. The `GHCR_READ_PAT` secret already existed (added 2026-05-21) but the workflow was never actually switched to use it. Now durable as long as the PAT stays No-expiration in GitHub.

### Contacts & Routing — source (platform) filter (2026-05-22)
`/settings/contacts` (`contact-settings-view.tsx`) gained a **Source filter** chip row (All / WhatsApp / Slack / SMS / Gmail / …) that scopes all three tabs (People/Contacts/Groups). Platforms are derived live from the loaded data (`availablePlatforms` = union of people-platforms + contacts + groups), so the chips only show sources that actually exist; the row hides itself when there's ≤1 platform. People match if any of their linked platforms matches; Contacts/Groups match on their `platform`. Resets contact pagination on change. Pure client-side filter — no server change.

### Outbound capture for phone messages — from_me plumbing (2026-05-22)
Phone-mirrored messages can now be **outbound** (the user's own sends), not just inbound. `PushMessageItem` gained an optional `from_me` flag; `message.ts` is now direction-aware (mirrors WhatsApp): the parsed peer is the **recipient** when `from_me`, the author when inbound. Outbound renders **`[SMS] You → Mom: "…"`** with `from_me:true` source routing (`sender_name:'(me)'`, `contact_name`=recipient, `person_id`), is indexed `processed:true` (informational — no batch review, no entity-status write), and the recipient is still resolved/enriched so "who did I message?" is answerable. Android side (separate repo `ll5-android`): a new `SentSmsObserver` (ContentObserver on `content://sms/sent`, gated by the SMS-tracking setting, READ_SMS already granted, no history backfill) pushes sent SMS as `from_me`; `NotificationCaptureService` now best-effort detects own replies in MessagingStyle `EXTRA_MESSAGES` (latest message with null sender ⇒ self) and flags them `from_me` (also fixes own-replies being mis-filed as inbound); Room DB v2→v3 adds the `fromMe` column. WhatsApp outbound already worked via Evolution `fromMe`. +1 gateway test (195 pass); Android compiles clean. Note: notification-only apps (Slack/Gmail) can't reliably capture *your* sends — no notification is posted — so outbound coverage is WhatsApp + SMS (reliable) + best-effort MessagingStyle.

### Shared message-identity module — Slack channel/author split + WhatsApp code reuse (2026-05-22)
Phone-app identity now shares one module with WhatsApp instead of duplicating logic: new `packages/gateway/src/processors/message-identity.ts` exports `parseMessageAuthor`, `enrichContact`, `buildSourceRouting`, called by **both** `message.ts` and `whatsapp-webhook.ts`. The win: **Slack `sender` arrives as `"#channel: Author (bot)"`** (the Android title packs the channel — which already duplicates `group_name` — plus a `(bot)` marker). `parseMessageAuthor` strips the redundant `"<channel>: "` prefix to recover the clean author, flags bots, and normalizes bare-number SMS senders. So Slack messages now resolve+enrich the **author** (e.g. `Opsgenie`) in `messaging_contacts` (not the channel), render `[Slack] Opsgenie (bot) in #data-platform-alerts: "…"`, pass the **clean author** as `sender` to the rule matcher (so a `sender` rule on `opsgenie` matches) with the channel as the `group` conversation (so a `group` rule on `alerts` mutes the whole channel) → Opsgenie/`#…-alerts` noise is filterable both ways. The ES doc gains `author`, `source:'phone'`, `is_bot`, and links `person_id` even for channel ("group") messages since a Slack author is a real entity. `enrichContact` is the unified upsert (curated-name guard + `last_seen_at`); WhatsApp's `enrichContactFromPushName` keeps its JID/self-name guards then delegates to it, and both processors build `SourceRoutingMeta` via `buildSourceRouting`. WhatsApp behavior unchanged (all its tests pass). +12 gateway tests (194 pass).

### Phone-mirrored messages (SMS/Slack/email) reach WhatsApp-level identity (2026-05-22)
The Android app already mirrors notifications from SMS + Slack + Gmail + Telegram/Signal/Messenger to the gateway, but `processors/message.ts` only emitted `[IM Notification] {sender} on {app}: "…"` with no identity. Now it's at WhatsApp parity: resolves+enriches the sender via `messaging_contacts` (keyed `platform=app`, e.g. 'sms'/'slack'/'gmail' — returns `person_id` + curated `display_name`, never clobbering a linked person), synthesizes a conversation key (`app:group:{name}` or `app:{sender}`), passes `platform`/`conversation_id`/`person_id` to the rule matcher (unlocking per-person + escalation routing), and on immediate/agent priority emits `[Slack] Alice in eng-sync: "…"` / `[SMS] Mom: "…"` **with full source routing** (`contact_name`, `person_id`, `from_me:false`, `remote_jid=convKey`). The `ll5_awareness_messages` doc now stores `conversation_id` + `person_id`. So the agent can `recall`/`get_narrative` on the sender for SMS/Slack/email exactly like WhatsApp. (Inbound-only; no `from_me` outbound for phone notifications. Reply tools exist only for WhatsApp/Telegram — these are for awareness/context.) +1 gateway test (182 pass).

### Messaging notifications now identify the peer + link the person (2026-05-22)
The agent's WhatsApp notifications didn't tell it WHO clearly: outbound (`fromMe`) messages rendered "[WhatsApp] You sent: …" with **no recipient name and no source routing at all**, and inbound surfaced `sender_name` but never the resolved `person_id`. Fixed in `whatsapp-webhook.ts`: resolve the conversation peer's `display_name` + `person_id` (data already queried for routing), render outbound as **`[WhatsApp] You → {recipient}: "…"`**, and attach `contact_name` (the peer — recipient when from_me, sender when inbound), `person_id`, `from_me` to the source-routing blob (`SourceRoutingMeta` extended). Channel MCP flattens the new keys (`source_contact_name`, `source_person_id`, `source_from_me`); CLAUDE.md + MCP instructions tell the agent to `recall`/`get_narrative` on `source_person_id` before acting and to treat `from_me=true` as the user's own outbound (note it, don't reply to the contact). Gateway tests updated, 181 pass. Telegram inherits the same `source.*` convention when its inbound is wired (no dedicated processor today).

### Location awareness: place/region state machine + arrival pushes (2026-05-22)
Replaced the >200m distance-threshold movement heuristic (which missed "you're home" — no clean >200m hop — and spammed a duplicate "Arrived at X" notable event on every in-place GPS jitter push). The location processor (`packages/gateway/src/processors/location.ts`) now tracks the user's current **semantic label** — a known place (≤100m, e.g. "Home") or the geocoded city/town (e.g. "Be'erotaim") — persisted per user in a tiny ES doc `ll5_awareness_location_state` (id=userId). Notifications fire only on a **transition** (label changes): writes a notable event (awareness), inserts a `[Location]` system message (agent context, no FCM), and sends a **direct FCM push** ("You're home" / "You're at X" / "You're in Be'erotaim") at `notify` level. Anti-flap dedup (no re-push of the same label within 5 min); in-transit/unknown points are awareness-only (no push). Location docs now also store `city`/`neighborhood`. New gateway test (6) for `deriveLabel`/`phraseArrival`. NOT yet: near-a-shop/POI proximity (geocode gives city/address, not nearby POIs) — a follow-up.

### Unify conversation surfaces — one live thread across CLI/web/Android (2026-05-21, flag-gated)
"CLI vs app diverge" + "agent responds in the wrong place" fix. Remote-control is closed (no third-party client) and an Agent-SDK rewrite is out of scope, so we keep the existing unified `chat_messages` thread and bridge the agent's Claude Code session to it with Claude Code hooks. WhatsApp/Telegram stay separate (contacts).

Shipped:
- **Gateway** (`chat.ts` + migration `025`): `POST /chat/messages` accepts `idempotency_key`; `ON CONFLICT DO NOTHING`, returns existing row as `200 {deduped:true}`, skips FCM. Makes hook auto-POSTs retry/double-fire-safe. +1 test (20 pass).
- **Channel MCP** (`ll5-run/channel/ll5-channel.mjs`): `reply` enum restricted to `web|system` (contacts only via send_whatsapp/send_telegram — kills "wrong place"); `reply`/`push_to_user` write a per-turn ledger; SSE listener writes `turn-context` + clears the ledger on each inbound and skips re-notifying self-posted `channel='cli'` rows (echo guard).
- **Hooks** (`ll5-run/.claude/hooks/`, **inert unless `LL5_MIRROR=1`; `=dry` logs only**): `activity-marker.sh` (PostToolUse allowlist → live compact activity rows), `stop-mirror.sh` (Stop → surfaces the agent's final user-facing prose, gated to user-facing turns via turn-context, deduped vs ledger), `cli-input-mirror.sh` (UserPromptSubmit → mirrors genuine CLI typing; suppresses slash-commands/envelopes; never writes stdout). Registered in `settings.json`. Dead `check-chat.sh`/`poll-chat.sh` removed.
- **Clients**: activity rows reuse the existing `display_compact` collapsible rendering + SSE (live) on web and Android — no required change; web `compactIcon` gains a distinct glyph for `metadata.kind:'activity'` (Send for WhatsApp/Telegram, Zap otherwise).
- **Agent instructions** (`CLAUDE.md` + MCP `instructions`): single-sink routing invariant (user ⇒ push_to_user/reply, contact ⇒ send_whatsapp/send_telegram) + `[[silent]]`/`[[compact]]` sentinels.

**Rollout state:** all code deployed but `LL5_MIRROR` is unset → fully inert (today's behavior). To activate: set `LL5_MIRROR=dry` in the agent's Coolify env (watch hook stderr logs a day), then `=1` for live. Android activity-icon polish is an optional follow-up.

### Narrative observationCount computed live on read — never trust the stored counter (2026-05-21)
`observation_count` on a narrative doc is only written during consolidation, so it goes stale the instant new observations are tagged (every narrative read `0` after the May cutover even though the substrate was rich — e.g. Rotem had 73 observations behind a count of 0). This looked like a "substrate-first violation" but was purely a stale display counter. Fix: `ElasticsearchNarrativeRepository` now recomputes the real count live from `ll5_knowledge_observations` (one filters-aggregation over the subjects) in `getBySubject` / `list` / `listForParticipant`, overwriting the stored value. Fail-safe: on ES error it keeps the stored value so reads never break. The stored field is now display-only/legacy. (Audit confirmed observations were correctly tagged — refs matched; one data-hygiene note: the Itamar-school-violence subject has split slugs `itamar-class-violence` vs `class-violence-itamar` worth a one-time merge.) Regression tests added (index-aware ES mock: narrative search returns a stale stored count, observations agg returns the real count) — verified they FAIL if the live recompute is removed (`expected 0 to be 73`). 82 personal-knowledge tests pass.

### agent-output-monitor: journal-aware liveness — fixes false "agent silent" FCM storms (2026-05-21)
The monitor measured agent liveness only by assistant chat-outbound rows. During legitimate silent work (e.g. consolidation backlog), the agent produces no chat outbound, so the monitor false-fired `critical` FCM ("LL5 agent silent — N triggers") every cooldown cycle — endless Android alarms. Fix: the monitor now also queries `ll5_agent_journal` (created_at/updated_at within the silence window) via ES; a journal touch counts as "alive". It only alerts when there is no chat outbound **and** no journal activity — i.e. the agent is genuinely unresponsive. `AgentOutputMonitor` now takes an ES `Client`; snapshot gains `journal_active_in_window`.

### Dashboard /settings/messaging — Evolution management UI (2026-05-18 PM)

After today's 2-hour recovery dance (raw SSH + Evolution REST + manual `UPDATE messaging_whatsapp_accounts SET ...`), the `/settings/messaging` page is no longer view-only. New UI capabilities:

- **Add WhatsApp account** — modal with `instance_name` input (validates `^[a-z0-9_]{1,64}$`, defaults to `ll5`). Submit → `provision_whatsapp_account` MCP tool creates the Evolution instance with the gateway webhook prefilled (`${GATEWAY_URL}/webhook/whatsapp` + `X-Webhook-Secret`), persists the re-encrypted `api_key` against the current `ENCRYPTION_KEY`, returns the initial QR code which the dialog renders.
- **Re-pair** — calls `get_pairing_qr` (GET `/instance/connect/{name}`) and opens the QR dialog. No row recreation.
- **Restart** — wires the existing `restart_whatsapp_account` tool through a server action button. For the ghost-connected case.
- **Disconnect** — calls `disconnect_whatsapp_account` (Evolution `DELETE /instance/logout/{name}`). Does NOT delete the row or the Evolution instance. Verbiage + `window.confirm()` says so explicitly.
- **Live status** — accounts list polls `list_accounts` every 10s. QR dialog additionally polls `get_account_status` every 5s and auto-closes + refreshes once status flips to `connected`. QR refetches every 30s while the dialog is open (Evolution rotates the QR).
- **StatusDot** colors: green `connected/open`, yellow (pulse) `connecting/qr_pending/reconnecting`, red `disconnected/close/token_invalid`.

New MCP tools in `@ll5/messaging`:
- `provision_whatsapp_account(instance_name)` — full provision: Evolution instance create + DB row + encrypted key + initial QR.
- `get_pairing_qr(account_id)` — fresh QR for an existing account.
- `disconnect_whatsapp_account(account_id)` — Evolution logout, keeps row + instance.

Static `EvolutionClient.createInstance()` helper added; instance methods `connect()` + `logout()` added.

New messaging-MCP env vars: `EVOLUTION_GLOBAL_API_KEY`, `GATEWAY_URL`, `WHATSAPP_WEBHOOK_SECRET` (all optional — provision tool returns a friendly config error if any is missing). Mirrored into `docker/docker-compose.prod.yml`.

Tests: messaging 39 → 52 (+13: covers provision config validation, encrypt-before-store, webhook-URL assembly, QR fetch + status-flip, logout, error envelopes). Gateway unchanged at 174. Dashboard untested (already convention).

The dashboard talks directly to the messaging MCP via the existing `mcpCallJsonSafe()` helper — no gateway routes added (the spec mentioned them, but the established pattern is dashboard → MCP, not dashboard → gateway → MCP).

### Dashboard /settings/scheduler runtime fix (2026-05-18 PM)

Same bug class as the data-sources one earlier today: `scheduler-server-actions.ts` had `"use server"` at the top while also exporting `DEFAULTS` (a const object). Next.js 15 rejects this. Extracted `DEFAULTS` + `SchedulerSettings` into a sibling `scheduler-types.ts` (no `"use server"`). View imports them from the types file now. Audited all other `"use server"` files in the dashboard — every other one only exports interfaces (types, stripped at compile, unaffected), so no further occurrences.

### Dashboard /settings/data-sources runtime fix (2026-05-18 PM)

The `data-sources-server-actions.ts` file had `"use server";` at the top but also exported `DEFAULTS` (a plain object) alongside its async server actions. Next.js 15 enforces *only async functions* in `"use server"` modules — runtime error `A "use server" file can only export async functions, found object`. The page hit a client-side exception and the entire dashboard became unusable for that route. Fix: extracted `DEFAULTS` + the type definitions into a sibling `data-sources-types.ts` (no `"use server"`). Both the server-action file and the view component now import the constants from there. Reminder for future routes: anything that isn't an `async function` lives in a non-`"use server"` file.

### Latent-bug cleanup from Phase 0 carryforward (2026-05-18 PM)

Three things the carryforward tests surfaced got addressed:
- `awareness/src/tools/notable-events.ts` — removed dead branch `e.acknowledged ? e.timestamp : null`. `queryUnacknowledged` filters `acknowledged=false` in ES, so the truthy branch was unreachable. `acknowledged_at` is now always `null`; corresponding test inverted to lock in the new contract.
- `awareness/src/tools/geo-search.ts` — exported `resetNominatimRateLimitForTests()` so the module-local rate-limiter state can be cleared between tests. Cuts the geo-search suite from >25s to ~1s. Production behavior unchanged.
- The third subagent-flagged bug (notification-rules.ts "missing try/catch around `await res.json()`") was a false alarm — the `await res.json()` IS inside the function's outer try/catch block.

### Last theater test eliminated: person-repository (2026-05-18 PM)

`packages/personal-knowledge/src/__tests__/person-repository.test.ts` was inlining its own `PersonDoc` interface and `docToPerson` function and asserting against that re-implementation — never invoking the real `ElasticsearchPersonRepository`. Rewritten to mirror the sibling observation/narrative test pattern: import the real class, mock at the `@elastic/elasticsearch.Client` boundary via a shared `makeEsClient(...)` helper, and exercise actual repo methods. File went from 25 inlined-mapping tests to 26 real behavioral tests covering `list` (filters, pagination, sort behavior with/without free-text query, result mapping), `get` (404, user_id mismatch, mapped success), `upsert` (create, merge-from-existing, status preservation/override, default status, forced-id-as-create), `delete` (scoped deleteByQuery), and `search` (boosted multi_match, highlight, score normalization, summary fallback). All 4 personal-knowledge test files now import real code (77 passing).

### CI compose-drift detection (2026-05-18 PM)

Follow-up to today's recovery: CI now fails the build if the on-host `/data/coolify/services/<uuid>/docker-compose.yml` has been manually edited and differs from `docker/docker-compose.prod.yml`. Implemented as a parallel `compose-drift-check` job in `.github/workflows/build-and-push.yml` (runs on every push to main, in parallel with build, does NOT block the deploy job — deploy still resyncs from repo, the whole point) plus a standalone `.github/workflows/compose-drift-check.yml` on a daily 06:00 UTC cron, so manual drift between deploys gets caught within 24h. Both jobs scp the host file via `appleboy/scp-action`, normalize trailing whitespace + comment-only lines + blank lines, then `diff -u`. Missing host file (first deploy ever / wiped service dir) is handled gracefully via a notice + exit 0, not a noisy failure. On mismatch the workflow logs the first 50 lines of the unified diff plus a pointer to the recovery procedure in `docs/HANDOFF.md`.

### MCP health-monitor probe prefers `API_KEY` over signed tokens (2026-05-18 PM)

Follow-up to today's `AUTH_SECRET` env fix. `MCPHealthMonitorScheduler.probeTools()` was Bearer-sending a `generateToken(userId, authSecret, …)` signed token to every target MCP — which works only when each MCP itself has `AUTH_SECRET` configured. The missing-`AUTH_SECRET` window on google + messaging produced false-positive `tool_count=0, probe_err="Invalid credentials"` rows in `/admin/health` (the actual MCPs were fine; only the probe was failing auth). Switched the probe to prefer `process.env.API_KEY` (universal Bearer accepted by every MCP regardless of its local `AUTH_SECRET`), with a fallback to the signed-token path when `API_KEY` isn't set so tests and legacy configs keep working. Wiring: `env.ts` (`apiKey: string | undefined`), `scheduler/index.ts` (passes `config.apiKey` into the monitor), `scheduler/mcp-health-monitor.ts` (`token = this.config.apiKey ?? generateToken(...)`).

### `AUTH_SECRET` added to google + messaging compose entries (2026-05-18 PM)

Per HANDOFF, google + messaging accept ll5 signed tokens when `AUTH_SECRET` is set via the shared auth middleware (which doesn't surface in each package's `env.ts` so it was missed during recovery compose rewrite). Without it, every signed-token call (dashboard → MCP) came back `401 "Invalid credentials"` — visible in `/admin/health` and on dashboard pages. Added the env var to both services. `services_unhealthy: 0` confirmed.

### Dashboard domain corrected (2026-05-18 PM)

Dashboard is on **`https://ll5.noninoni.click`**, not `zzz.arnonzamir.co.il` (incorrect placeholder in older HANDOFF revisions and used by mistake during the recovery below). Repo compose + traefik label corrected. The old `zzz.` host now returns 503 (no upstream).

### Infrastructure Recovery (2026-05-18 PM): compose is now repo-source-of-truth

After today's morning outage (Coolify nightly docker cleanup pruned image layers + GHCR auth had expired + on-host compose pinned to a deleted SHA tag), recovery revealed that **the Coolify-stored compose only ever declared 4 services** (ES, PG, personal-knowledge, gtd) while the other 7 (gateway, dashboard, awareness, google, health, messaging, evolution-xkkcc) had been running as docker-run-side-loaded orphan containers for ~50 days. A `docker compose up -d --remove-orphans` call during recovery removed those orphans. No data was lost (PG + ES volumes intact, ~15k chat msgs / 77k WhatsApp msgs / etc. preserved). Recovery actions:

- Rewrote `docker/docker-compose.prod.yml` as the comprehensive 10-service canonical compose (ES + PG + 6 MCPs + gateway + dashboard) with correct traefik labels, healthchecks, `container_name` convention, log rotation, resource limits.
- Generated fresh `AUTH_SECRET` and `ENCRYPTION_KEY`. Mirrored all 14 env vars into Coolify's per-service env-var store so future deploys don't lose them. (Pre-recovery only `WHATSAPP_WEBHOOK_SECRET` was in Coolify; everything else lived only in destroyed orphans.) Side-effect: existing client tokens (web, Android, ll5-agent) invalidated — must re-login. Encrypted blobs in PG (Google OAuth tokens, encrypted WhatsApp keys) became garbage — must re-auth Google + re-enter Evolution key via dashboard.
- PG password drift detected (cluster's stored ll5 password ≠ env-var). Reset via `ALTER USER ll5 WITH PASSWORD ...` over the trust-mode unix socket.
- CI now scp's `docker/docker-compose.prod.yml` to the host before each deploy — repo is authoritative. Workflow comment explicitly forbids `--remove-orphans` (with a pointer to the incident).
- ll5-agent restarted to mint a fresh signed token against the new `AUTH_SECRET`.

Drift detection follow-ups:
- ✅ CI compose-drift check — parallel job on push + daily 06:00 UTC scheduled workflow (see entry above). Rejected gateway-side scheduler approach: gateway runs in a container and can't see the docker host's filesystem without socket access, which we don't want.
- Gateway scheduler: weekly cross-check `docker compose ps` against declared services list, FCM-warn on mismatch. (Different signal — detects orphan containers, not file drift; still useful.)
- `/admin/health` field: `compose_drift_warnings`.

### Hardening Phase 0 (2026-05-18): tests are now real

Following a code review that found ~80 "theater" tests across the test suite — tests that didn't actually invoke the code they claimed to cover — Phase 0 rewrote the worst offenders against the new standard in [`docs/testing.md`](testing.md). Every rewritten test now imports the real handler/repo, mocks at the client boundary (`pg.Pool` / `@elastic/elasticsearch.Client`), and asserts on real return values plus mandatory `user_id` scoping.

| Package | Before | After | Notes |
|---------|--------|-------|-------|
| gtd | 45 (mostly theater) | 32 real | dropped tests that re-derived defaults or called mocks then asserted on them |
| awareness | 47 (mostly theater) | 46 real | deleted inline `haversineDistance` copy; geo-search now untested (follow-up) |
| health | 30 (mostly theater) | 35 real | covers PG sources, ES queries, sync orchestration |
| personal-knowledge / people-tools | 8 (all theater) | 14 real | handlers captured via stub `McpServer` |
| google | 11 (~55% theater) | 27 real | Google API mocked at boundary |
| messaging | 11 (~45% theater) | 28 real | `encryption.test.ts` was already clean |
| gateway / new retry test | 0 | 8 real | exercises 23505 retry loop in `getOrCreateActiveConversation` |

**Total: 428 tests passing across all packages, all real.** Each package has its own `__tests__/_helpers.ts` with `captureTools()` for invoking MCP tool handlers. New helper standard documented in [`docs/testing.md`](testing.md).

Follow-ups carried forward (all done — see Phase 0 carryforward section below):
- ✅ Personal-knowledge repository tests all import real classes now.
- ✅ Geo-search test coverage (re-added `haversineDistance` as a unit-testable helper in `utils/geo.ts`; 25 new tests cover the four geo tools).
- ✅ Awareness tool tests for the eight previously-uncovered tools (calendar, entity-statuses, location, media, notable-events, notification-rules, phone-status, wifi).
- ✅ Health `clients/registry.ts` refactored out of process-global state into a `HealthClientRegistry` class with a default instance for back-compat.

### Hardening Phase 1 — critical security (2026-05-18, partial)

Three of the four code-level security gaps from the review are closed. The fourth (secret rotation) is operator action, not code.

**1.2 WhatsApp webhook authenticated.** `POST /webhook/whatsapp[/*]` now requires `X-Webhook-Secret` header matching the new `WHATSAPP_WEBHOOK_SECRET` env var (32+ chars, fail-closed). The "first user" fallback when the instance is unknown is gone — unknown instance now returns 404. The inline route handler was extracted into `src/whatsapp-webhook-route.ts` with 10 dedicated tests.

⚠️ **Deploy will fail on next restart until `WHATSAPP_WEBHOOK_SECRET` is set in Coolify env.** Generate via `openssl rand -hex 32`, set in Coolify, then configure Evolution API to send the same value in `X-Webhook-Secret` on its outbound webhook calls.

**1.3 `/uploads` gated behind auth + ownership.** New `src/uploads-route.ts` enforces:
- Bearer / query-token auth via the existing `chatAuthMiddleware`.
- Per-file ownership check: filename must begin with the requester's userId (chat uploads) or contain the matching `userId.slice(0,8)` (WhatsApp media). Path traversal, separator-collision attacks, and dotfiles all rejected.
- Filename randomness bumped from 4 bytes (8 hex, scannable in ~minutes) to 16 bytes (32 hex) in both `chat.ts` and `whatsapp-webhook.ts`.
- Dashboard proxy `app/api/uploads/[...path]/route.ts` now forwards the `ll5_token` cookie as a bearer header, requires it, and switched cache header from `public` to `private`. 11 tests cover the ownership logic including prefix-collision and traversal attacks.

**1.4 Path-token webhook deprecated.** `POST /webhook/:token` now emits `Deprecation: true`, `Sunset: Wed, 31 Dec 2026 23:59:59 GMT`, and `Link: </webhook>; rel="successor-version"` headers, plus a warning log with the User-Agent. Canonical bearer-only form `POST /webhook` mounted. Existing Android-app clients keep working; can be removed once they migrate.

**Test suite: 449 passing across all packages** (+21 from Phase 0's 428). Full typecheck clean.

Still outstanding for the operator (not code):
- Rotate leaked secrets in `HANDOFF.md` (admin PIN `1234`, AUTH_SECRET, Postgres `changeme123`, Coolify API token). Scrub the file, add `docs/SECRETS.md` pointing to where they actually live, add `gitleaks` pre-commit hook.

Next: Phase 2 — auth consolidation (the four reimplementations of token validation in `chat.ts`, `admin.ts`, and `server.ts`×2 → single `validateLl5Token()` helper in `@ll5/shared`; bcrypt timing leak in `auth.ts:101`).

### Hardening Phase 2 — auth consolidation + timing leak (2026-05-18)

Done. Single source of truth for `ll5.*` token validation, and the user-enumeration timing channel on `POST /auth/token` is closed.

**2.1 `validateLl5Token` in `@ll5/shared`.** New pure helper in `packages/shared/src/auth/token.ts` returning a `ValidationResult` discriminated union (`{ ok: true, claims } | { ok: false, reason: 'malformed' | 'bad_signature' | 'expired' | 'wrong_prefix' }`). Constant-time HMAC compare via `crypto.timingSafeEqual` with a length-equality guard so the compare never throws. Pure, no I/O. 20 dedicated tests cover malformed (3 shapes), wrong_prefix, bad_signature (length-match, length-mismatch, tampered payload, wrong secret, non-hex chars), expired (real and synthetic clock), grace-period acceptance, role round-trip, role default, and unknown-role coercion to `user` (no privilege escalation via the role field).

**2.2 Four inline validators replaced.** `chatAuthMiddleware` (chat.ts), `requireAdmin` (admin.ts), and both webhook code paths in `server.ts` (path-segment token + Bearer header fallback) now all delegate to `validateLl5Token`. The variants previously differed: server.ts both paths skipped the `parts[0] === 'll5'` check on the Bearer-header branch and didn't distinguish between `expired` and `bad_signature` (any failure was just "Invalid webhook token"); chat.ts/admin.ts did parse the prefix but returned `'Invalid token format'` for non-3-segment and `'Invalid token'` for everything else; admin.ts additionally enforced `role === 'admin'`. The new code path preserves every observable HTTP behavior (status codes, error bodies including `token_expired` and `Admin access required`).

**2.3 Bcrypt-adjacent timing leak in `auth.ts` (line ~101).** The previous code returned `404 'User not found'` when the user row didn't exist and `401 'Invalid PIN'` only after `bcrypt.compare`. That leaked which usernames were valid in two ways: (a) status code differed, (b) timing differed — the no-user branch returned in <1ms while the wrong-PIN branch took ~150ms because bcrypt.compare wasn't called. Fix: a module-level `DECOY_PIN_HASH` is now compared against when the user is missing so the cost is uniform, both branches return `401 'Invalid credentials'` (same body, same status), and the rate-limiter records failed attempts on both. `pinValid` is now an `await`ed boolean from `bcrypt.compare` against either the real hash or the decoy — `bcrypt.compare` itself was already constant-time, so the only fix needed was always calling it.

**Test suite: 471 passing across all packages** (+22 from Phase 1's 449 — 20 from new validateLl5Token coverage, 2 from earlier shared test). Full typecheck clean. Gateway test count unchanged at 174.

### Hardening Phase 0 carryforward (2026-05-18)

The three follow-up bullets that were tracked-but-not-done after the original Phase 0 are now closed. After this commit, every MCP package has real test coverage on its tool layer, geo-search has its first tests, and health's client registry is no longer process-global.

**Awareness — eight previously uncovered tools now have real tests.** `calendar`, `entity-statuses`, `location` (incl. `where_is_user`, `query_location_history`, `delete_location_point`), `media` (incl. `upload_media`, `list_media`, `link_media`, `unlink_media`, `get_media_for`, `delete_media` with cross-tenant guard), `notable-events`, `notification-rules` (the three gateway-proxy tools, with `fetch` mocked), `phone-status`, and `wifi`. New file: `packages/awareness/src/__tests__/tools-extra.test.ts`. Awareness tests: 46 → 126 (+80).

**Geo-search has tests.** `haversineDistance` was deleted from `tools/geo-search.ts` along with the Phase 0 inline-helper cleanup; it's back as a pure unit-testable helper at `packages/awareness/src/utils/geo.ts` and the four geo tools (`search_nearby_pois`, `geocode_address`, `get_area_context`, `get_distance`) get real coverage in `packages/awareness/src/__tests__/geo-search.test.ts` with `fetch` mocked via `vi.stubGlobal`. Distance helper validated against known city pairs (NYC↔LA ≈ 3935km, London↔Paris ≈ 344km, antipodes ≈ 20015km).

**Health `clients/registry.ts` is no longer process-global.** Refactored from three top-level functions backed by a module-level `Map` to a `HealthClientRegistry` class with the map as an instance field. Default instance `registry` is exported for production callers (no call-site changes), and the existing `registerAdapter` / `getAdapter` / `listAdapters` functions remain as back-compat shims delegating to it. Tests can now `new HealthClientRegistry()` per test for isolation; previously two test files using `--pool=threads` could have corrupted each other. New file: `packages/health/src/__tests__/registry.test.ts` (9 tests covering register/get/list/clear, overwrite semantics, per-instance isolation, and the back-compat shim).

**Test suite: 560 passing across all packages** (+89 from Phase 2's 471 — 80 from new awareness tool tests + geo-search, 9 from registry isolation tests). Awareness: 46→126. Health: 35→44. Other packages unchanged. Full typecheck clean across all 11 packages; awareness + health builds clean.


### Deployed Services (Coolify @ 95.216.23.208)

| Service | Status | URL |
|---------|--------|-----|
| personal-knowledge MCP | Live | mcp-knowledge.noninoni.click |
| gtd MCP | Live | mcp-gtd.noninoni.click |
| awareness MCP | Live | mcp-awareness.noninoni.click |
| calendar MCP | Live | mcp-google.noninoni.click |
| health MCP | Live | mcp-health.noninoni.click |
| messaging MCP | Live | mcp-messaging.noninoni.click |
| gateway | Live | gateway.noninoni.click |
| dashboard | Live | ll5.noninoni.click |
| Elasticsearch 8.15.0 | Healthy | internal |
| PostgreSQL 16 | Healthy | internal |

### Client (ll5-run)

| Component | Status |
|-----------|--------|
| MCP connections (6) | Working |
| Skills | review, daily, clarify, engage, sweep, plan, welcome, consolidate, catchup, calendar-review, doc-audit |
| Welcome launcher | Working |
| Chat bridge (SSE listener) | Working |
| Stop/FileChanged hooks | Configured |
| Auth (signed tokens + PIN) | Working |

## Tool & Page Counts

Counts go stale. To get current numbers:

```bash
# MCP tools per package
for pkg in personal-knowledge gtd awareness google messaging health; do
  echo "$pkg: $(grep -r 'server\.tool(' packages/$pkg/src/tools/ | wc -l | tr -d ' ')"
done
# Channel MCP tools
grep "name: '" ll5-run/channel/ll5-channel.mjs | wc -l
# Dashboard pages
find packages/dashboard/src/app -name "page.tsx" | wc -l
# Gateway schedulers
ls packages/gateway/src/scheduler/*.ts | wc -l
# Gateway REST endpoints
grep -E 'app\.(get|post|put|patch|delete)\(' packages/gateway/src/server.ts packages/gateway/src/chat.ts | wc -l
```

Last audited (2026-04-07): 111 tools, 33 pages, 10 schedulers, ~39 REST endpoints.

## Roadmap Status

### Done

| Feature | Date | Notes |
|---------|------|-------|
| Unified contacts & routing | Apr 6-7 | contact_settings table, 3-tab UI (people/contacts/groups), contact-only person stubs, link/unlink/auto-match, optimistic UI + sessionStorage cache |
| Geo search | Apr 5 | Built into awareness MCP (not separate MCP): search_nearby_pois, geocode_address, get_area_context, get_distance |
| Push notification levels | Apr 3 | 4 levels (silent/notify/alert/critical), agent chooses per push, user ceiling + quiet hours |
| Source routing for replies | Apr 7 | metadata.source on system messages, channel MCP passes to agent, agent replies on correct platform |
| Conversation escalation | Apr 4 | User activity in ignored/batched chat → 30-min immediate window |
| Journal consolidation | Apr 1 | User model ES index, nightly consolidation trigger |
| Proactive agent | Apr 4 | 8 schedulers, audit trail, data-rich heartbeat, agent nudge |
| Health MCP | Mar 31 | Garmin: sleep, HR, body battery, HRV, VO2 Max, respiration, training readiness |
| Calendar integration | Mar 29 | Google Cal + phone sync, ticklers (recurring), week view, availability check |
| WhatsApp integration | Mar 30+ | Evolution API, webhook, image download, pushName enrichment, contact sync (2,874 contacts) |
| Android app | Mar 29 | Chat, GPS, notification capture, FCM, Health Connect |
| User management | Apr 8 | All 5 phases: AsyncLocalStorage, admin CRUD, username login, rate limiting, PIN validation, multi-user schedulers, WhatsApp routing, onboarding, families |
| Narratives system | May 5 | Per-subject rollups + atomic observations as the agent's shadow notebook on the user's world. 7 MCP tools, ES indices, gateway scheduler (default off), dashboard pages, /catchup + /review + /daily updates, /backfill-narratives skill. Discriminator vs journal/user_model/GTD: emotionally-connected, listen-mostly, retrieve-by-context, surface-rarely. |
| Data source config | Apr 7-8 | Per-source toggles, gateway enforcement, dashboard UI, Android device command sync |
| Health polling scheduler | Apr 7 | Polls every 20min, sleep/activity/HR/stress/energy/weight detection, 7-day baselines |
| Admin log explorer | Apr 8 | Datadog-style: faceted sidebar, time range, search, slide-out detail, separate app/audit pages |
| Test suite (369 tests) | Apr 8-9 | All 8 packages: shared, gateway, knowledge, gtd, awareness, health, messaging, google |
| Auto-match contacts | Apr 9 | Person-first, Hebrew-Latin cross-script, multi-candidate UI, name similarity scoring |
| Android phone contacts push | Apr 9 | Address book sync → gateway → messaging_contacts enrichment (fixes 2043 nameless contacts) |
| WhatsApp image download fix | Apr 9 | Gateway decrypts Evolution API key before media download (was passing encrypted key) |
| WhatsApp contact name enrichment | Apr 10 | Group message pushName extraction, CONTACTS_UPSERT/UPDATE webhook, backfill tool (24K messages), LID→phone mapping via participantAlt |
| System MCP (local stdio) | Apr 13 | New @ll5/system package — local stdio MCP, 6 tools (battery, cpu, memory, disk, system_info, system_health). First non-remote MCP. Source in ll5/packages/system; registered in ll5-run/.mcp.json with absolute path. Pull-only; thresholds fire warning/critical in `get_system_health`. |
| Phone status + WiFi push pipeline | Apr 13 | Android collects battery/charging/storage/ram via BatteryStateReceiver (push on plug/5%-delta/low-cross) + current WiFi via ConnectivityManager.NetworkCallback (push on connect/disconnect/ssid_change). 1h DeviceHeartbeatWorker fallback. Gateway: 2 new schemas + processors, wifi processor auto-learns BSSID→place from co-occurrence with GPS. Awareness MCP: 2 new ES indices, 4 new tools (get_phone_status, get_phone_status_history, get_current_wifi, get_wifi_history). Personal-knowledge MCP: ll5_knowledge_networks index, NetworkRepository, 4 tools (find_place_by_bssid, label_network, unlabel_network, list_known_networks). APK built, dex verified, 8 new classes shipped. |
| WhatsApp flow + phone liveness monitors | Apr 17 | Closes the two gaps that hid the Apr 16 outage: (1) `whatsapp-flow-monitor` alerts critical via FCM when ES has seen zero inbound WhatsApp for 6h+ during active hours (catches Evolution's "ghost connected" Baileys failure that mcp-health-monitor can't see); (2) `phone-liveness-monitor` alerts critical when neither `ll5_awareness_locations` nor `ll5_awareness_phone_statuses` has fired in 3h+ during active hours (promotes the heartbeat-message string warning to an FCM push). New messaging MCP tool `restart_whatsapp_account` issues `POST /instance/restart/:name` to Evolution for manual recovery. Both monitors expose snapshots via `/admin/health` (`whatsapp[]` + `phones[]` + `summary.whatsapp_stale` + `summary.phones_stale`). Same 5-alerts-per-episode + 30-min-cooldown shape as the existing channel-liveness monitor. |
| MCP + channel failsafe monitoring | Apr 15 | Channel MCP hardened (AbortController + 60s idle timeout on SSE, unhandledRejection/uncaughtException handlers, token-refresh-triggered reconnect, health file at `~/.ll5/channel-health.json`, new `channel_health` tool). Gateway schedulers: `mcp-health-monitor` (pings all 7 services + aggregates error rate from `ll5_app_log` every 2 min, alerts on 2 consecutive failures via FCM critical); `channel-liveness-monitor` (detects pending inbound messages stalled >5 min during active hours, 10-min cooldown on alerts). New `/admin/health` endpoint returns cached aggregate. Dashboard `/admin` page shows all 7 services + databases + per-user channel liveness. Client watchdog rewritten to be liveness-aware: reads `channel-health.json`, FCM-pushes user when claude session dead or channel stalled; no more nohup restart spam. |

### Not Built — Planned

| Feature | Design Doc | Priority | Effort |
|---------|-----------|----------|--------|
| ~~Android phone contacts push~~ | — | ~~Medium~~ | ~~DONE (Apr 9)~~ |
| ~~WhatsApp history backfill~~ | — | ~~Low~~ | ~~DONE (Apr 10)~~ |
| Unified conversations — dashboard UI (sidebar, search, reply-to quote, reactions, compact rendering) | docs/design/unified-conversations.md | High | Medium — backend done Apr 19; UI is follow-on |
| Unified conversations — Android UI (swipe-reply, long-press react, compact rows, `conversation_switched` pivot, FCM→message scroll) | docs/design/unified-conversations.md | High | Medium — needs APK build |
| Email sync from phone | ROADMAP.md | Low | Medium — Android ContentProvider for metadata |
| Money tracking MCP | ROADMAP.md | Low | Large — bank APIs, categorization, projections |

### Tech Debt

| Item | Priority |
|------|----------|
| Auth hardening (device-bound sessions, passkeys, or OAuth) | Low — current PIN+bcrypt sufficient for family use |
| Tests: 368 passing across 8 packages. Dashboard uncovered. | Low |
| Evolution API findContacts times out on full dataset (2913 contacts) | Low — workaround: single-JID queries work |
| `routing='agent'` is a vestigial enum value that behaves identically to `routing='immediate'` in every processor. Dropped from the dashboard UI on May 3 (legacy rows display as Notify); migration to remove from the `contact_settings.routing` CHECK constraint is not yet done. | Low — UI is the source of truth users interact with; DB cleanup is cosmetic |

## Recent Changes

- 2026-05-15: **Retire `channel-liveness-monitor` entirely.** The monitor was already documented as DEPRECATED for the server-agent topology since 2026-05-12 (threshold raised to 3600s to make it effectively-off), but it was still firing duplicate "messages not delivered" FCM criticals today because the agent can legitimately stall >1h during long tool clusters and the throttled channel MCP's pending queue ages past any threshold during bursts — gateway has no way to distinguish "stuck in throttle" from "channel MCP is dead". `agent-output-monitor` (added 2026-04-23, tightened to 0.5h on 2026-05-12) now owns the "agent isn't keeping up" signal end-to-end and is throttle-aware because it watches outbound flow not pending depth. Deleted: `packages/gateway/src/scheduler/channel-liveness-monitor.ts`, its registration in `scheduler/index.ts` and import in `admin.ts`, the `channels: ChannelLiveness[]` array and `summary.channels_stale` from `/admin/health` response, the matching `ChannelLiveness` type + "Channel bridge liveness" panel from the dashboard `/admin` health view. No scheduler UI references; no test references; nothing left to flip back on if Mac-style bridge is ever revived (we'd rebuild a smaller probe at that point). 145 gateway tests still pass; full 11-package typecheck clean; dashboard build clean.
- 2026-05-14: **mcp-health-monitor gains a `tools/list` probe; retire dead `mcp-status-pulse`.** On 2026-05-13 awareness sat in "connected but cannot list tools" mode for ~22h while `/health` returned 200 the whole time — the monitor's only signal was the HTTP ping, so nothing on the gateway side actually exercised tool-listing and the failure went unalerted. Fixed: every cycle (still 2min) now runs both `/health` HTTP and an MCP `tools/list` call via streamable-HTTP against `${url}/mcp`, authenticating with a `generateToken`-minted bearer for the monitor's userId. A cycle counts as failed if either probe errors or `tool_count === 0`. Composite error string distinguishes "/health 503" vs "/health ok, tools/list timed out" vs "/health ok, tools/list returned 0 tools" so FCM body + `/admin/health` payload are actionable. Gateway entry skips the tools probe (plain HTTP, no `/mcp` endpoint). Snapshot grew two additive fields (`tool_count`, `tools_probe_error`) — dashboard's `health-actions.ts` reads stay backwards-compatible; surfacing the new fields in the UI is a follow-up. Independent `ll5_app_log` error-rate sweep unchanged. Same time: deleted `mcp-status-pulse.ts` and its registration — the 3-day stabilisation pulse self-expired 2026-04-21 and was dead code. Gateway adds `@modelcontextprotocol/sdk` as an explicit dep (was already hoisted via `@ll5/shared`). 145 gateway tests still pass; full 11-package typecheck clean.
- 2026-05-13: **Stuck-message sweep + channel MCP marks system rows delivered on delivery.** Fixes the "15 rows pinned at pending/processing for 30+ hours" issue observed on 2026-05-12. Root cause: channel MCP marked every inbound `processing` on delivery to claude and waited for the agent's `reply` tool with `reply_to_id` to flip it to `delivered`. But for `channel='system'` inbounds (WhatsApp arrivals, scheduler triggers, watchdog notes, escalations, …) the agent typically handles them via `push_to_user` / journal / silent acknowledgment — never via `reply`. So those rows pinned at `processing` indefinitely and the gateway's pending-age channel-liveness monitor read them as stuck (alerting "agent disconnected" while the agent was actually fine). **Two-pronged fix:** (1) Channel MCP (in `ll5-run` commit `759d963`) now marks `system`-channel inbounds as `delivered` directly on delivery instead of `processing` — they don't have a per-message "did the agent really reply" expectation. User-channel inbounds (web/android/cli) still go through `processing → delivered-on-reply` because those DO need that signal for UI status indicators. (2) New gateway scheduler `stuck-message-sweep` (`packages/gateway/src/scheduler/stuck-message-sweep.ts`) — runs every 10 min, flips any system-channel row stuck in `pending`/`processing` for 30+ min to `delivered`. Safety net for any row that still slips through (network blip during PATCH, future code path that forgets to mark). Per-user scoped via `user_id` filter. On first run it self-heals the existing 15 stuck rows. Tunable via user_settings: `stuck_message_sweep_minutes`, `stuck_message_after_minutes`.
- 2026-05-13: **`primary_language` profile field — explicit response-language override for the agent.** The agent was responding in Hebrew because the user profile listed Hebrew among `languages[]` and claude reasonably inferred Hebrew was a preference. It's not — `languages[]` is just "I understand these". New `primary_language` keyword field on `ll5_knowledge_profile`: when set ("English", "Hebrew", "Spanish"), the agent responds in that language regardless of the language of the user's current message (verbatim quotes still stay in their original language). When empty/undefined, falls back to the default-English-with-Hebrew-match heuristic in `ll5-run/CLAUDE.md`. Plumbing: new field in `Profile` type + ES mapping + `get_profile`/`update_profile` MCP tools (both already wired through the repository). Dashboard `/profile` page gains a "Response Language" card with a dropdown (Automatic / Always English / Always Hebrew / Always Spanish); saves on change. Companion CLAUDE.md sections added in ll5-run (commits `5818af2` shipping the immediate default-English rule + `f6b2cbc` documenting the override).
- 2026-05-12: **Channel-liveness-monitor effectively disabled; agent-output-monitor becomes primary.** The channel-liveness-monitor (`packages/gateway/src/scheduler/channel-liveness-monitor.ts`) was firing critical FCM alerts saying "agent disconnected" while the agent was actually fine — the monitor measures staleness on the *oldest pending* inbound message, and the server agent's channel MCP now **throttles deliveries to claude at 1 event / 5 sec by design** (the 2026-05-11 fix for the Athens-trip backlog hang). A 60-event burst legitimately ages past the old 5-min threshold without anything being broken. The gateway has no way to distinguish "stuck in our throttle queue" from "channel MCP is dead". Raised `channel_stale_seconds` default from 300 → 3600 (effectively-off; the monitor remains in the codebase as a fallback for any future Mac-style bridge topology — set the user_setting to lower the threshold if needed). At the same time, **tightened `agent_output_silence_hours` from 2h → 0.5h** so the agent-output-monitor — which measures "events arrived recently, none got answered" — becomes the primary "agent isn't keeping up" signal. That monitor is throttle-aware by design (it watches outbound flow, not pending staleness), and 30 min strikes the balance between catching real hangs quickly and tolerating long tool-call clusters (narrative consolidation, weekly review, etc.).
- 2026-05-11: **Dashboard chat tile gets the same instant-load treatment.** `chat-widget.tsx` (the small chat panel on /dashboard) had the same cold-load pattern as /chat — `/conversations/active` → `/messages?limit=200` waterfall on every dashboard visit, plus a 200-limit sweep every 30s. Added the same `loadCache`/`saveCache` helpers as the full-screen view; **shares the same `ll5_chat_cache_v1` localStorage key** so writes from one surface warm the other. Bootstrap now: read cache → paint instantly + mark initialized → in background fetch fresh active and reconcile. First-fetch limit dropped 200→30; sweep 200→50. Widget keeps its own plain useState (no migration to the zustand store) — cache reuse comes free via shared key.
- 2026-05-11: **Instant chat — render-cached-then-refresh on web + Android.** Cold open of `/chat` was 5–30s because every visit did a `force-dynamic` server-side fetch (two sequential round-trips: `/chat/conversations/active` → `/chat/messages?limit=200`, both `cache:no-store`), then the client *also* re-fetched `?limit=200` on mount, then the safety sweep also pulled 200 every 15s. Same shape on Android: `loadConversation` did sequential server fetches (active → messages) before showing anything; cached `conversationId` was used only as fallback if the server call failed; no message cache at all. **Fix:** localStorage cache (web) / DataStore cache (android) holds last 30 messages + active convId; on cold open both surfaces paint cached state in <100ms, then fetch fresh in parallel and merge. Default first-fetch limit dropped from 200 → 30 on both surfaces; sweep dropped to 50 (was 200) and now also writes the cache so the next open sees current state. Web side: `/chat/page.tsx` is now a thin client shell (no server-side `loadInitial`); bootstrap moved into `useChatSession` (cache hydrate → parallel `/active` + `/messages?limit=30` → ingest). Removed the duplicate `useEffect`-on-convId refetch that was firing the same query the server had just pre-rendered. Android side: new `cachedChatMessagesJson` String preference in `SettingsRepository` (single-key — only one active LL5-native conversation per user); `ChatRepository` injects Moshi to ser/de a `List<ChatMessageDto>` via the existing adapter; `ChatViewModel.loadConversation` now reads cache → renders instantly (no spinner unless cache empty) → fetches fresh in parallel → persists tail. APK built clean (assembleDebug); dashboard typechecks clean. Cache key versioned (`ll5_chat_cache_v1`, `cached_chat_messages_v1`) so future schema changes can bump-and-discard.
- 2026-05-05: **Narratives system shipped end-to-end (Phases 1–4).** New first-class concept: the agent's shadow notebook about the user's world — evolving, listen-mostly, retrieve-by-context. Distinct from journal (atomic, agent's voice), user_model (stable truth about *self*), and GTD projects (mechanical outcome+actions). Subjects are person/place/group(JID/chat_id)/topic(slug). Two layers: **observations** (atomic, append-only, multi-subject-tagged, with provenance + confidence + sensitivity flag) and **narratives** (lazy per-subject rollup with summary, mood, open_threads, recent_decisions, status active/dormant/closed). **Storage:** two new ES indices in `@ll5/shared/indices/narratives.ts` (`ll5_knowledge_observations` with nested subjects mapping for OR-recall; `ll5_knowledge_narratives` with deterministic doc id `{user}::{kind}::{ref}` enforcing one narrative per subject). Wired into `personal-knowledge/src/setup/indices.ts`. **Repositories:** `ObservationRepository` (create/recall/statsForSubject/listForSubject/delete) + `NarrativeRepository` (getBySubject/list/listForParticipant/upsert/delete) with sensitivity bumped logical-OR (never lowered) and required `closed_reason` on close transitions. **MCP tools (7 new on personal-knowledge — total now 28):** `note_observation` (primary write — agent calls constantly during conversation processing, validates person/place refs against KB, group/topic accepted as-is, audit-logged), `recall` (primary read — by subjects + free-text + since, returns observations newest-first plus narratives if include_narrative=true), `list_narratives` (status/kind/participant/stale_for_days/query filters), `get_narrative` (full per-subject load), `upsert_narrative` (create/update with sensitivity-bump rule), `delete_observation` (no update — observations are atomic; if wrong, delete and re-note), `consolidate_narrative` (helper: returns current narrative + new observations since last_consolidated_at + guidance string; agent then calls upsert_narrative to write the rewritten summary). **Agent integration (ll5-run/CLAUDE.md):** new "Narratives — Your Shadow Notebook" section explaining when to note vs journal vs recall vs upsert vs consolidate, sensitivity discipline (informational not gating — system is private), tools added to inventory. **/catchup updated** to load `list_narratives({status:"active"})` + `stale_for_days:14` snapshot at session start (silent absorb). **/review updated** with new Phase 6 "Narratives Sweep" — top 5–10 active narratives, capture updates as observations, consolidate when stale, close completed threads. **/daily updated** to optionally surface one narrative when unusually quiet/loud. **New `/backfill-narratives` skill:** agent-driven one-time pass over journal (~90d) + WhatsApp/Telegram from agent/immediate conversations (~60d) + recent chat history; agent judges what's worth noting (not mechanical extraction); then coins topic slugs and consolidates. **Gateway scheduler:** `narrative-consolidation` (default OFF; enable per-user via `user_settings.scheduler.narrative_consolidation_enabled = true`; when on, fires once a day at configured hour — default 3am, an hour after journal-consolidation — asking the agent to scan list_narratives and refresh threads with ≥5 new observations since last_consolidated_at; transitions to dormant for 60+ day quiet narratives). **Dashboard /narratives:** read-only list view with status/kind/search filters and live filter count chips; per-subject `/narratives/detail?kind=&ref=` shows summary + current_mood + open_threads + recent_decisions + full chronological observations timeline (with source badge + confidence + sensitive marker per observation); single-action close button with required reason, plus mark-dormant and reopen. Nav entry added under People & Places (Sparkles icon). **Tests:** 77 personal-knowledge tests pass (was 41) — observation repo (recall nested subject filter, OR semantics, free-text must, since range, ascending sort for consolidation, stats aggs, scoped delete) and narrative repo (deterministic id, title required on create, closed_reason required on close, sensitivity OR-bump never lowered, status/kind/participant/stale filters, missing _last sort). **Living docs updated:** `docs/design/narratives.md` (full design), this PROGRESS, HANDOFF, FILE_TREE.
- 2026-05-04: **Coupled-to-ignore rule.** Mirror of the May 3 paired-bump-out-of-ignore: when the user moves one column TO ignore (Authority→Blocked or Delivery→Drop) and the other is currently active, the active twin also drops to ignore. Rationale: blocking authority and dropping delivery are two halves of the same intent — silencing a contact — and neither alone fully silences. Renamed the helper `pairedBump → pairedAdjust` and made it bidirectional. Six call-sites in the Row components fire a second optimistic update + server upsert when a coupling triggers.
- 2026-05-03: **Groups tab now unions both messaging tables.** The Groups list was reading only `messaging_conversations` (via `list_conversations`), which returns whatever Evolution caches in `findChats` (active-chat cache, partial — Baileys decides). The contacts table `messaging_contacts` where `is_group=true` (via `list_contacts`) holds the broader address-book set Evolution returned in `findContacts`. On arnonzamir's account that's 150 vs 203. `fetchGroupsWithSettings` now fetches both in parallel and unions on `conversation_id`, preferring `messaging_conversations` rows when both sources have the same JID (so `is_archived` + activity metadata wins). Defensive: any row whose `platform_id` doesn't match the platform's group-id shape (`@g.us` for WhatsApp, leading `-` for Telegram) is skipped to avoid the `is_group` column ever leaking 1:1 contacts into the Groups tab.
- 2026-05-03: **HOTFIX** — `list_people` Zod schema `max(200)` was rejecting the dashboard's `limit:5000` calls (introduced earlier today to fix People↔Contacts flapping), causing the contacts page to stick on "Loading…" because the server-action threw on input validation. Bumped the schema cap on `personal-knowledge/src/tools/people.ts` to 5000 with a doc comment explaining the dashboard need. 41 personal-knowledge tests still pass.
- 2026-05-03: **/settings/contacts: filtered tab counts + harder group/contact split.** Three bugs in one cleanup. (a) Groups tab count was always showing the raw total (e.g. 150) regardless of search filter — `tabs[].count` for Groups read `groups.length` while Contacts read `filteredContacts.length`. Now all three tabs (People / Contacts / Groups) use the filtered length, so search narrows every count consistently. (b) Some legitimate groups leaked into the Contacts tab because the `messaging_contacts.is_group` column is unreliable on legacy rows. Hardened the categorization in `fetchContactsForTab()`: any platform_id ending with `@g.us` (WhatsApp groups) or starting with `-` for Telegram is excluded from the Contacts tab regardless of the `is_group` column. (c) Items "jumping" between People and Contacts on refresh — caused by `list_people` being capped at `limit:200` while `fullPersonIds.has(c.person_id)` is the discriminator. Contacts linked to KB people beyond #200 failed the test and dropped into Contacts on some renders, were correctly categorized on others. Bumped all three call sites to `limit:5000`.
- 2026-05-03: **Drop `Auto` from Delivery UI** (UI-only, no schema change). The `agent` value in `contact_settings.routing` is a no-op vestige — every processor (`whatsapp-webhook.ts:372,447`, `message.ts:85`) checks `priority === 'immediate' || priority === 'agent'` together, identical behavior. Removed `agent` from `ROUTING_OPTIONS` in `contact-settings-view.tsx`; legacy rows that currently store `routing='agent'` go through `displayRouting()` which normalizes to `'immediate'` for display so the active button stays highlighted. DB CHECK constraints unchanged — migration to drop `agent` from the routing enum is queued in tech-debt (low priority; UI is the truth users interact with).
- 2026-05-03: **WhatsApp batch review now carries conversation attribution.** Two related fixes. (1) Writer: `whatsapp-webhook.ts` was not emitting `conversation_id` (= remoteJid) or `conversation_name` to ES — only `is_group` + `group_name`. So `awareness.query_im_messages` always returned null for both fields, and the agent couldn't tell which group a sender was writing in. Now the messageDoc includes both; mapping in `@ll5/shared/indices/awareness.ts` already had the keyword/text definitions, no migration needed. (2) Batch summary: `MessageBatchReviewScheduler` was grouping by `sender|app` only, dropping group context. Reworked to cluster by `sender|app|conversation_id` (falling back to `group_name` for older rows lacking conversation_id), and the system message now reads e.g. `- Shai Shevah (whatsapp) in "Pi Makers": 14 messages [conv:120363...@g.us]` with first + last snippets per cluster and a closing pointer to `read_messages` for fetching the full thread. Phone-IM processor (`message.ts`) intentionally not changed — phone push payloads don't carry JID-level conversation_id; that's a structural limit of the phone source. 145 gateway tests still pass.
- 2026-05-03: **/settings/contacts toggle polish: distinct labels + paired bump.** Authority and Delivery toggles previously displayed overlapping words ("ignore" and "agent" appeared on both). Now each column shows column-specific labels: Authority `ignore→Blocked, input→Read, agent→Reply`; Delivery `ignore→Drop, batch→Batch, immediate→Notify, agent→Auto`. The underlying enum values in PG are unchanged — only the display labels differ. Tooltip on each button shows the canonical name. Coupled-bump-out-of-ignore: when both Authority and Delivery are at `ignore` and the user clicks one off ignore, the other automatically bumps to its first non-ignore level (permission→input, routing→batch). Mental model: opening one means you intend to engage with the contact, so the silent twin shouldn't quietly veto. Implemented as a `pairedBump()` helper called from each Row's onChange handler — fires a second optimistic update + server upsert when triggered.
- 2026-05-03: **Inline reaction strip, Authority/Delivery relabel, and read-gate now reads contact_settings.permission.** (1) Long-press / hover action bar on chat messages now shows all 6 reactions inline (agree, disagree, ack, reject, confused, thinking) plus reply + copy in a single row — saves the click into the prior reaction sub-picker. Same shape on android: a single ModalBottomSheet replaces the two-step actionSheet→reactionSheet flow, with `IconActionButton` rendering eight icons across the row. REACTION_ORDER reordered to put thumbs first. The popover ReactionPicker component is removed from both message-bubble.tsx and chat-widget.tsx. (2) `/settings/contacts` columns relabeled "Permission" → "Authority" and "Routing" → "Delivery" to surface the distinct concepts and prevent confusion (both columns use overlapping `ignore`/`agent` values). Tooltip on each header explains the semantic. (3) **Read-gate fix**: `messaging.read_messages` + `send_whatsapp` + `send_telegram` previously checked `notification_rules.priority` only. Updated `getConversationPriority` in `packages/messaging/src/utils/permission-checker.ts` to read `contact_settings.permission` first via a join through `messaging_contacts` (handles both group target_type='group' with platform_id JID, and 1:1 target_type='person' with KB person_id). Falls back to `notification_rules` for any row not yet migrated. Mapping: contact_settings permission `agent`→`agent`, `input`→`batch`, `ignore`→`ignore`. Now the Authority toggle in /settings/contacts is actually enforced. 40 messaging tests pass.
- 2026-05-03: **Migration 024 — chat NOTIFY now includes metadata.kind.** The earlier `narrate` shipment stored `metadata.kind="thinking"` on chat rows but the existing `notify_chat_message` trigger (migration 023) cherry-picks fields and didn't pass metadata through. SSE clients received no `metadata` field on `new_message` events, so narrate rows initially rendered as default CompactRows; only when the safety-poll sweep refetched (15s web, 30s android) did the row flip to the asterisk/italic ThinkingRow. Migration 024 projects a small `metadata` object into the NOTIFY payload (just `kind` for now, pattern is extensible) — stays well under the 8KB NOTIFY limit. Clients already read `data.metadata.kind` so no client change required. Auto-applied on next gateway restart via the existing migrations runner.
- 2026-05-03: **Web user-msg dupe race fix + `narrate` channel for agent's internal voice.** Two related chat fixes. (1) Race in dashboard's `ingest()` — when SSE delivered a user's just-sent message before the POST response had a chance to call `promoteTemp`, the optimistic temp echo and the SSE row both stayed in state, and the subsequent `promoteTemp` rewrite created two rows with the same real id. Symptom: occasional duplicated user messages, more visible while the "coach is thinking" indicator was up (because that's exactly when SSE is fastest relative to POST). Fix in `packages/dashboard/src/hooks/use-chat-store.ts:ingest()` and the parallel `packages/dashboard/src/components/chat-widget.tsx` SSE handler: when a non-temp user message arrives without a matching id and without a `pendingByTempId` mapping, look for a temp echo with same role+content+reply_to_id and recent timestamp (±30s) and reconcile in-place. (2) New `narrate` tool in `ll5-run/channel/ll5-channel.mjs` so the agent can share its internal voice mid-task. Writes a chat row with `display_compact=true` and `metadata.kind="thinking"`. Both web (`message-bubble.tsx` and `chat-widget.tsx` `CompactRow`) and android (`ChatScreen.kt:ThinkingRow`) detect `metadata.kind === "thinking"` and render asterisk-prefixed italic lines (web: dim ink-400; android: 70% onSurfaceVariant + italic). Android version collapses to 2 lines with tap-to-expand. `MessageMetadata` in android DTOs gained a `kind` field. CLAUDE.md gains a section on when to narrate vs reply vs push_to_user. No FCM trigger — narrate is silent on phones, just visible. Dashboard typecheck clean; android `compileDebugKotlin` clean; 145 gateway tests still pass.
- 2026-04-30: **Time-confusion fix + sharper proactive prompts.** Symptom: agent was summarizing yesterday's events as today's, and mixing UTC/local timestamps from tool responses. Root cause: every data source returned ISO UTC; the heartbeat injected localized strings without TZ name or year; `get_situation` was the only tool that paired both. Over long sessions (especially post-compaction) the anchor drifted. Fixes: (1) new `formatTime(date, tz)` + `timeBanner(date, tz)` + `sessionTimezone()` helpers in `@ll5/shared/utils/time.ts` — every paired output is `{utc, local, tz}` where `local` is `YYYY-MM-DD HH:MM Weekday`. (2) Heartbeat (`scheduler/heartbeat.ts`) now opens with the full anchored banner (`2026-04-30 Tuesday 14:30 Asia/Jerusalem (UTC: 2026-04-30T11:30:00Z)`) plus an explicit "anchoring rule" line; default cadence raised 60→30 min so re-anchoring happens twice as often. (3) `character-refresh` now embeds the time-banner + an explicit time contract (paired utc/local fields, "today/yesterday/tomorrow" resolve in session TZ, never cross-mix), and the persona text was rewritten to push proactivity — Executor creates tasks/ticklers without asking, Coach initiates conversations and pushes the user on stale projects/goals. Hard line: agent must NOT send messages on the user's behalf. (4) Tool responses now include paired local time alongside UTC: `messaging.read_messages` (WhatsApp + Telegram) adds `local_time` per message + `tz` envelope; `awareness.get_calendar_events` adds `start_local`/`end_local` + `tz`; `awareness.read_journal` adds `created_at_local`/`updated_at_local`; `awareness.query_location_history` adds `timestamp_local`. (5) `google.create_tickler` no longer hardcodes `Asia/Jerusalem` — uses `sessionTimezone()` (reads `process.env.TZ`, falls back to host IANA zone, then UTC). (6) Proactive scheduler prompts rewritten from passive ("please review X") to coaching ("act on what you find — don't just summarize", "open the day with the user, name what matters most, ask the question that locks in the first move"): `gtd-health`, `daily-review`, `weekly-review`, `tickler-alert`. Daily-review header also uses `timeBanner` so the date is always anchored. All 27 google + 40 messaging + 47 awareness + 145 gateway tests still pass; one google test mock needed `sessionTimezone` added.
- 2026-04-23: **GPS cleanup page — time range + outside-Israel filter + one-click scan-and-delete.** Added a time-range selector (24 h / 3 d / 7 d / 30 d / all) that narrows the ES query up front, a 4th criterion ("Outside Israel" — point outside the 29.4°–33.4°N / 34.2°–35.9°E bounding box, i.e. Eilat to Hermon, Mediterranean to Dead Sea), and a "Scan & delete" button that runs scan + delete in one server action without the preview step — intended for routine cleanup runs when you already trust the criteria. Default checkbox state is `speed + out_of_israel` since those are the two the user most often wants to prune without review. Preview flow still available via the "Scan (preview)" button → per-criterion checkboxes → "Delete selected" button.
- 2026-04-23: **GPS cleanup admin page — prune points the broken filters let through.** New `/admin/gps-cleanup` dashboard page scans `ll5_awareness_locations` against the three filters the gateway was silently skipping before today's fixes: (A) accuracy >100 m, (B) implausible speed >150 km/h between consecutive points within 10 min, (C) drift >500 m from a known-place point within 5 min. Dashboard server actions (`gps-cleanup-server-actions.ts`) use the same direct-ES fetch pattern as the admin log explorer — dashboard container sits on the internal Coolify network so `http://elasticsearch:9200` is reachable; no gateway endpoint needed. Two actions: `scanBadGpsPoints()` pages through the whole history with search_after, walks pairs, returns counts + samples per criterion; `deleteGpsPoints(ids)` issues a scoped `_delete_by_query` (filtered on `user_id + ids`) so nothing outside the current admin's own data can be touched. UI shows per-criterion cards with checkboxes, a combined deletion count, and previews up to 50 rows per section; post-delete auto-rescans so the before/after is visible in one click. Admin nav gains a "GPS Cleanup" link.
- 2026-04-23: **GPS/location pipeline audit — fixes + LocationService + build-safety net.** Three silent bugs in `packages/gateway/src/processors/location.ts` that were shipping despite `strict: true`: (1) `haversine(prev.location.lat, prev.location.lon, item.lat, item.lon)` called the 2-arg function with 4 args — drift filter always returned `NaN` and never blocked implausible GPS jumps; (2) three sites read `item.accuracy` but the Zod schema field is `accuracy_m` — 100 m accuracy filter was a no-op, so cell-tower-grade fixes were being stored; (3) the gateway's `writeNotableEvent` emitted `{event_type, place_id, place_name, location, details, timestamp}` while the awareness MCP reader filters on `acknowledged: false` and sorts by `created_at` — every arrival event the gateway wrote was silently invisible to `get_notable_events`. Root cause for the silent-build: gateway builds with `tsc` default `noEmitOnError: false`, so TS reported all 4 errors but still emitted JS, and CI only ran `npm run build` (no separate typecheck gate). Fixes: `noEmitOnError: true` in the root tsconfig; root `typecheck` script now iterates all 11 packages; CI gains a `Typecheck target package` step before build; `gateway/tsconfig.json` excludes `__tests__` (vitest transpiles on its own). Plus a 5th error in `utils/export.ts` that had been lurking (`request_timeout` → options arg). Index consolidation: moved the 7 overlapping `ll5_awareness_*` definitions and `ll5_knowledge_networks` into `packages/shared/src/indices/` as a single source of truth; `gateway/src/server.ts`, `awareness/src/setup/indices.ts`, and `personal-knowledge/src/setup/indices.ts` all import from `@ll5/shared` now. Reconciled the `notable_events` schema split — writers now emit the canonical `{summary, severity, payload, acknowledged, created_at}` shape the reader expects (event_type for arrivals renamed to `location_change`; place details go into `payload`). LocationService (`packages/awareness/src/services/location-service.ts`) fuses latest GPS + current wifi BSSID → `ll5_knowledge_networks` inference into a single CurrentLocation with provenance (`place`, `confidence: high|medium|low|unknown`, `source: gps|wifi|gps+wifi|stale_gps|none`, `reasoning`); `get_current_location` rewritten to use it (legacy fields preserved, new `fused` block added); new `where_is_user` tool for decision-making. Design doc: `docs/design/LOCATION_SERVICE.md`. Smaller fixes bundled: `/webhook/:token` now rate-limited to 120 req/min per user (sliding window, same pattern as auth.ts); movement-notify dedups by last-destination+10min-window so GPS jitter doesn't fire repeated system messages; `query_location_history`'s misleading `place_filter` renamed to `place_id` with clearer description (was doc'd as "fuzzy name match" but always required an exact UUID). Deferred as tech debt: stationary-point collapsing (user call — can live with it for now); Nominatim rate limiter is still process-global in `utils/geocoding.ts` (not worth the churn at single-user scale).
- 2026-04-23: **Agent character reshape + periodic refresh.** The Apr 23 07:00–13:59 silence wasn't a bug — the agent correctly applied the previous "silent unless actionable" default. Good judgment, wrong disposition. Updated `ll5-run/CLAUDE.md` (commit `e03a006`) to a new two-roles-one-temperament framing: Executor now narrates lightly instead of working invisibly; Coach widens from "only when ambiguity detected" to forward-looking (drift from goals, stalling projects, things about to matter); temperament is threaded through both — curious, occasionally shares for interest, half-formed thoughts OK, "silence should be a choice, not a reflex." Because the prompt is loaded once at session start and drift compounds over long-running sessions (the current one has been up 48h), added `character-refresh` scheduler on the gateway: inserts a condensed 75-word `[Character Refresh]` system message via `insertSystemMessage` every 4h during active hours. No FCM push — agent-internal signal only. Per-user tunable via `user_settings.scheduler.character_refresh_hours`.
- 2026-04-23: **Agent-output monitor — closes the "channel drains but agent silent" blind spot.** Today's 7h proactive-silence (07:00–13:59) went completely undetected: mcp-health green (laptop process is client-side), channel-liveness green (if the channel MCP drains pending→processing but the agent never emits a reply, nothing piles up), whatsapp/phone-liveness green (unrelated). New `agent-output-monitor.ts` ticks every 15min during active hours, reads two numbers — count of `channel='system'` inbound rows in the lookback window (default 3h) and `MAX(created_at) WHERE direction='outbound' AND role='assistant'`. Stale when the agent has been silent ≥ `silenceHours` (default 2h) AND there were ≥ `minSystemInbound` triggers (default 2) in the window — silence-with-no-triggers stays quiet so we don't page on a genuinely uneventful morning. Same shape as the other failsafe monitors: FCM critical, 2 alerts per episode, 30-min cooldown, counter resets on recovery; `/admin/health.agent_output` + `summary.agent_output_stale` expose the snapshot, and the dashboard `/admin` health tab grows an "Agent output" section next to the existing channel/WhatsApp/phone panels. Per-user config keys: `agent_output_minutes`, `agent_output_min_triggers`, `agent_output_silence_hours`, `agent_output_lookback_hours`.
- 2026-04-22: **Dashboard token auto-refresh + hard redirect on expiry.** The dashboard had no refresh path, so when the ll5 session token's `exp` passed, every server-action call to an MCP came back `401 {"error":"token_expired"}` — silently in most places, visibly in the calendar Reconnect flow ("Server error (401): token_expired" under the button). `middleware.ts` now decodes the cookie's payload (edge-safe base64url), and when `secondsLeft < 2 days` calls `POST /auth/refresh` (gateway already supported this with a 7-day grace — channel MCP + Android used it, dashboard didn't). On refresh success it writes the new token to both `request.cookies` (via `NextResponse.next({ request })` so the current request's server components/actions see it) and the outgoing response cookie. Beyond the grace period — or for malformed tokens — it clears the cookie and redirects to `/login?next=<path>`, matching the existing "no cookie" path so no page can render in an unauthenticated state.
- 2026-04-22: **Fix calendar Reconnect button "does nothing".** `handleReconnect` in `calendar/settings/calendar-settings-view.tsx` (and `handleConnectGoogle` in `onboarding/onboarding-view.tsx`) called `window.open(auth_url, '_blank')` *after* `await getGoogleAuthUrl()`. Chrome/Safari drop the user-gesture flag across the network round-trip and silently block the popup — symptom was the button briefly flashing "Connecting..." then going quiet with no error and calendar staying disconnected. Fix: open `about:blank` synchronously at click time (preserves the gesture), then assign `popup.location.href` once the auth URL resolves; fall back to `window.location.href` if even the blank popup was blocked, and `popup?.close()` on auth_url error. Same fix applied to the onboarding wizard's Google step. No server-side changes needed — `/api/auth-url` was working fine; the UX layer was eating the redirect.
- 2026-04-21: **Post-incident review hardening — 12 findings closed.** Schema-migrations ledger (migration 000, first-boot backfill detects legacy deploys — no file re-runs); per-scheduler health registry `utils/scheduler-health.ts` wired via `withSchedulerHealth()` to the 5 non-inserting monitors (mcp-health, channel-liveness, whatsapp-flow, phone-liveness, mcp-status-pulse) + implicitly via `insertSystemMessage` for the 10 inserting schedulers; FCM failure counter with per-reason breakdown; chat-search-indexer exposes reconnect_count + exponential backoff (5s→60s cap); webhook-stats counter for phone-contact enrichment + calendar-cleanup silent catches; response-timeout scheduler routed through `insertSystemMessage` (no more unguarded raw INSERT); `chat.ts` `getOrCreateActiveConversation` bounded 3-attempt retry on 23505 races; `scheduler/index.ts` empty-body catches now distinguish 42P01 (expected first-deploy) from real DB errors. `/admin/health` grows: `schedulers[]`, `fcm`, `chat_indexer`, `webhook` — plus summary counters. `HANDOFF.md` documents the new migration discipline (ledger-backed + DROP FUNCTION IF EXISTS CASCADE for future function-signature changes) and the active-conversation invariant (`getOrCreateActiveConversation` is the only sanctioned path). 145 gateway tests still pass.
- 2026-04-21: **Hotfix — migration 021 was non-idempotent.** `ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_reaction_xor_content CHECK(...)` had no IF-NOT-EXISTS guard (PG 16 doesn't support that directly on ADD CONSTRAINT). Hid since Apr 19 because the gateway container was never restarted — dashboard-only deploys don't rebuild gateway. Tonight's gateway rebuild (for the 020+022 fix below) triggered the first migration replay since Apr 19, and the gateway crash-looped ~4 min on 42710 "constraint already exists" before this fix. Wrap the ADD CONSTRAINT in a `DO $$ ... pg_constraint lookup ... END $$` block.
- 2026-04-21: **Incident fix — 37h proactive-layer blackout caused by migrations 020+022.** Symptom: no heartbeat, no tickler alerts, no daily/weekly review, no health polling, no escalation notices, no WhatsApp→agent conversion from 2026-04-19T19:28Z through 2026-04-21T08:20Z. Morning silence + missed Ritalin reminders + hallucinated kid-prep decision on Apr 21 all trace back. Root cause: migration 020 added `idx_chat_conversations_one_active ON chat_conversations(user_id) WHERE archived_at IS NULL`; migration 022 made the `notify_chat_message` trigger also `INSERT ... ON CONFLICT(conversation_id)` into `chat_conversations` for `channel IN ('web','android','cli','system')`. But `insertSystemMessage` generates a fresh `conversation_id` per event — each new row violates the partial-unique index (ON CONFLICT on the PK doesn't cover it), 23505 aborts the chat_messages insert, and the error was silently swallowed at `logger.warn`. Fix (migration 023 + chat.ts + system-message.ts): (1) scope the trigger's counter-maintenance block to `('web','android','cli')` only — `system` is ephemeral per-event, never forms a thread; (2) drop `system` from `UNIFIED_CHANNELS` for consistency (POST /chat/messages no longer routes system-channel inserts through active-conversation resolution); (3) upgrade the swallow site to `logger.error` with full context (user_id, scheduler, event_id, pg error code) plus a module-level failure counter exposed via `/admin/health.system_messages{total_failures, last_failure_at, last_error_code, recent_by_scheduler}`. Migration 023 also deletes the ~575 archived synthetic chat_conversations rows created by the 020 backfill from system-only conversation_ids (scoped to `archived_at IS NOT NULL` so the user's active row is never touched). All 145 gateway tests still pass.
- 2026-04-20: Full-screen `/chat` route — "Claude.ai × CLI" coach view. Lives under `app/(user)/chat/page.tsx` (server component seeds initial active convo + history, ChatRoot client hydrates). Distinct from the dashboard tile's `chat-widget.tsx` — both import shared modules (`lib/chat/{types,constants,format}.ts`, `components/chat/message-bubble.tsx` with unboxed/bubble variants) to avoid drift; widget stays on plain useState. New view uses a **Zustand store** (`hooks/use-chat-store.ts`) with a single `ingest(source, msg)` funnel that replaces the 3-writer race in the widget (echo, SSE, sweep). Store owns the 409-grace auto-retry, conversation_archived pivot, temp-id promotion, and status merge; `thinking=true` on send, `thinking=false` when any assistant message arrives via SSE (the "agent answered" validation). Warm palette tokens added (`surface-page/thread/sunken/rail`, `ink-300→900`, `coach-50/500/700`) + `font-mono` stack + `chat-caret` blink keyframe. Unboxed assistant with coach-dot gutter (stays LTR even when content is RTL); quiet sunken user bubble; compact system rows with 60s grouping collapse; reaction strip under parent; reply-to quote above bubble; cmd+k command palette (commands + conversation switcher); cmd+N/B/K/Enter shortcuts; slash-command hints (`/new`, `/clear`); paste-to-attach image; deterministic daily placeholder; empty state with greeting + example prompts + hairline. `(user)/layout.tsx` branches on path: `/chat` uses full-bleed main, everything else keeps the `max-w-7xl` wrapper. Nav gains a top-level Chat link. `next build` passes all 42 routes; shipping to prod for end-to-end verification.
- 2026-04-19: Auth redirect enforcement on web + Android. Web: moved the login-redirect check into `src/middleware.ts` (was only in `(user)/layout.tsx` — `(admin)` routes were reachable without a token and would server-error). Middleware now redirects any non-public path to `/login?next=<path>` when the `ll5_token` cookie is missing; login action honors `next` (same-origin only, no open-redirect). `(user)/layout.tsx` keeps its check as defense-in-depth. Android (ll5-android commit f2ea4cf): `AppNavigation` observes a new `SettingsRepository.isAuthenticated` StateFlow and replaces the whole tabbed nav with a Settings-only "Sign in" screen when false — Chat/Status/Data are unmounted entirely so the user can't swipe to broken screens. Flow flips in-place when `setAuthToken` is called, so login transitions are seamless. APK rebuilt and installed on device `a1989465`.
- 2026-04-19: Unified conversations on Android (ll5-android commit c413c10) — closes out the three-repo rollout (backend + dashboard + Android). ChatMessage/ChatSendResponse/ChatEvent DTOs gain `reply_to_id`, `reaction`, `display_compact`, `code`, `active_conversation_id`, `rerouted_from`; `content` is nullable. New ChatApi endpoints (`/chat/conversations/active`, `/new`, `PATCH /chat/messages/{id}`). ViewModel loads active from the server on startup (DataStore becomes offline-only cache), pivots on `conversation_archived` SSE events, auto-retries on 409. UI: Material3 ModalBottomSheet long-press action sheet (Reply/React/Copy), 6-icon reaction sheet (Check/ThumbUp/ThumbDown/Close/HelpOutline/MoreHoriz), reply-to quoted parent above bubble + cancellable banner above composer, per-bubble reaction strip with counts, compact monospace rendering for `display_compact=true` with 60s-grouped collapsible "N system events" band. Top-bar "+" opens a new-conversation dialog with optional summary. `compileDebugKotlin` BUILD SUCCESSFUL; ships via manual APK install (no CI auto-deploy for Android).
- 2026-04-19: Unified conversations dashboard UI — rebuilds the chat widget on top of the new backend. Loads `/api/chat/conversations/active` on mount; SSE handler pivots on `conversation_archived`/`conversation_created` events and auto-retries sends that hit a 409 grace-window archive. Compact rendering for `display_compact=true` with 60s grouping collapse; reactions as a hover-picker + per-parent icon strip with counts and click-to-remove; reply-to quote strips (text snippet + 40px image thumbnail) both in the composer and above the bubble; new-conversation dialog with optional summary textarea. New `chat-sidebar.tsx` with active/archived list + 300ms-debounced ES-backed search (renders `<em>` highlight snippets). 4 new API proxy routes: `/api/chat/conversations/new|active|search|[id]`. `next build` passes all 41 routes; not visually smoke-tested — shipping to prod for direct use.
- 2026-04-19: Unified conversations backend (web/android/cli share one active LL5 thread) — fixes the long-standing `push_to_user` "notification without visible message" bug where pushes landed in a conversation the user wasn't looking at. New migrations 020–022 add `chat_conversations` (with `UNIQUE INDEX WHERE archived_at IS NULL` enforcing one active per user + 14-day dormant-gate backfill), `reaction` + `display_compact` columns with XOR constraint and nullable content, and rewrite the NOTIFY trigger to maintain conversation counters and include new fields in both SSE payloads. Gateway gains: `/chat/conversations/new` (atomic archive+open with agent-authored summary), `/chat/conversations/active`, `/chat/conversations/search` (ES-first via new cluster-wide `chat-search-indexer` scheduler with multilingual analyzer for Hebrew; ILIKE fallback on last 500 conversations), reaction upsert via `PATCH /chat/messages/:id`, 30s grace window + `409 conversation_archived` on mid-switch writes. Channel MCP: simplified `push_to_user` (drops channel heuristic — server routes to active), new `new_conversation` + `react` tools, SSE handler passes `reply_to_id`/`reaction`/`display_compact` through meta, handles `conversation_archived`/`conversation_created` lifecycle events as compact notifications, and treats reaction rows as meta-only acknowledgments (not conversation turns). Dashboard + Android UI changes are follow-ons; backend ships green with 145 gateway tests (17 new) + 401 total across all packages. Design doc: `docs/design/unified-conversations.md`.
- 2026-04-18: Dashboard `/admin` health tab updated to show the new `whatsapp[]` and `phones[]` monitor snapshots alongside services/channels/DBs, with per-service last-healthy-at, consecutive-failure count, and status-code/error details. New gateway scheduler `mcp-status-pulse` fires an FCM-level-notify status summary every 2 h during active hours through 2026-04-21, then self-expires (the existing failsafe monitors — which only fire on failure — remain afterward). On the client: launchd agent `com.ll5.mcp-autoheal` runs every 5 min, reads `~/.ll5/channel-health.json`, and triggers `reconnect-mcps.sh --apply --relaunch` after 2 consecutive failing probes (1 h cooldown between relaunches). Two new ll5-run scripts (`type-to-terminal.sh`, `reconnect-mcps.sh`) support both manual and automated recovery.
- 2026-04-18: Fix intermittent `/mcp` "failed" at Claude Code startup + add proactive MCP probe (ll5-run repo, commit 751347b). Root cause: Claude Code v2.1.83+ bounds MCP connect at 5s; six parallel TLS+auth+init handshakes routinely tip past that under load, and Claude Code silently marks a random subset failed. Fix: launcher now exports `MCP_TIMEOUT=30000` and pre-warms `/health` on all six MCPs in parallel (populates DNS + TLS session caches before claude spawns its clients). Channel MCP now (a) writes the refreshed token atomically via tmpfile+rename so the 6 `headersHelper` readers never see a truncated file, (b) dropped the dead `updateMcpJsonToken()` regex rewrite (hurt more than helped — current config uses `headersHelper`, not inline bearer strings), (c) probes all 6 remote MCPs 15s after startup + every 10min using the same streamable-HTTP+bearer code path Claude Code uses, writes results to `~/.ll5/channel-health.json`, exposes a new `check_mcp_connectivity` tool, and posts a rate-limited (1/h) system chat message if any probe fails.
- 2026-04-17: Alert cap 5 → 2 across all four failsafe monitors (mcp-health, channel-liveness, whatsapp-flow, phone-liveness). Five FCM criticals per episode was noisy during extended outages (especially phone stalls). Two is enough — first as signal, second as confirmation. Counter still resets on recovery, so a new episode re-arms.
- 2026-04-17: CI deploy command_timeout 5m → 15m. Prior 5-min bump wasn't enough — `docker pull` + `compose up -d` on the server regularly exceeded 5 min, especially under host pressure. Also gitignored `.mcp.json` and `.claude/` so the project-scoped Coolify MCP config (holds an API token) stays out of git.
- 2026-04-17: Host-pressure postmortem on the 27h WhatsApp outage — the initial "Baileys ghost-session" diagnosis was wrong. Actual chain: an unrelated project (`zlf-infra`) had a runaway 99 GB Elasticsearch volume on the shared Coolify host, OOM-looping, pressuring ll5's Postgres. Evolution's Prisma connection pool never recovered from a resulting Postgres flap even though the container stayed `Up 7d` and self-reported `state: open`. Recovery: `docker restart evolution-xkkcc0g4o48kkcows8488so4`. Prevention (one-shot): stopped all four zlf services + pruned zlf volumes (99 GB reclaimed, disk 175→74 GB). Known gap still open — no host-level resource monitor; the new `whatsapp-flow-monitor` and `phone-liveness-monitor` catch symptom indices, not host pressure. Coolify API quirk observed: service detail endpoint stays `status: exited` while the list shows live `running:*`, and `/stop` refuses on the stale state — workaround is `/start` first to force reconcile.
- 2026-04-17: WhatsApp + phone liveness monitors. The Apr 16 outage was invisible to `mcp-health-monitor` because Evolution's `connectionState` reported `open` even though the Baileys WhatsApp Web socket had silently desynced — zero inbound messages for 27h while our health dashboard showed all-green. Two new schedulers close that gap: `whatsapp-flow-monitor` (ES-based, alerts if no inbound WhatsApp in 6h during active hours) and `phone-liveness-monitor` (alerts if no GPS/phone_status in 3h, replacing the heartbeat string-warning with an actual FCM critical). New `restart_whatsapp_account` MCP tool on messaging calls Evolution's `/instance/restart/:name` for manual recovery without needing Coolify access. Both monitors follow the existing channel-liveness pattern (active-hours gate, 30-min cooldown, 5-alerts-per-episode cap, in-memory snapshot cached for `/admin/health`).
- 2026-04-16: CI deploy fix: `docker compose pull` was pulling ALL images including `postgres:16-alpine`. A new patch release caused compose to recreate the PG container during deploy, the SSH action timed out mid-recreate (default timeout too short), leaving postgres + gateway in `Created` (not running) state. All PG-dependent MCPs lost their DB. Fix: deploy now only pulls our GHCR-built images (explicit `docker pull` per image), SSH timeout increased to 5 min. Databases and third-party images are never pulled during deploy.
- 2026-04-16: Monitor alert cap: both MCP health monitor and channel liveness monitor now stop alerting after 5 FCM pushes per episode. Counter resets when the condition clears (service recovers / pending messages drain). Prevents indefinite spam when a condition persists beyond user's ability to act.
- 2026-04-15: mcp-health-monitor gateway self-ping — post-deploy verification showed the gateway row reporting unhealthy because the default self-URL was `http://localhost:3006` but the container binds `PORT=3000` in Coolify. Switched to `http://127.0.0.1:${PORT ?? 3006}` so dev and prod both resolve.
- 2026-04-15: MCP + channel failsafe monitoring — root cause of the Apr 14–15 outage was a silent SSE stall in the channel MCP (laptop sleep/wake left the TCP socket half-dead; the reader never timed out and the process eventually died without Claude Code respawning it). Session log showed an 11h 37min delivery gap. Fixes: (1) channel MCP `ll5-run/channel/ll5-channel.mjs` now aborts SSE on 60s idle, reconnects after token refresh, writes `~/.ll5/channel-health.json` every 15s, exposes `channel_health` tool, and crashes cleanly on unhandled errors so the MCP SDK respawns it; (2) gateway `mcp-health-monitor` scheduler pings all 7 services + aggregates tool error rates from `ll5_app_log` every 2 min, FCM-alerts on 2 consecutive failures or >25% error rate on ≥10 samples; (3) gateway `channel-liveness-monitor` scheduler watches for pending inbound messages stalled >5 min during active hours (the "bridge looks alive but isn't delivering" mode), FCM-alerts critical with 10-min cooldown; (4) new `GET /admin/health` endpoint aggregates both monitors + live PG ping; (5) dashboard `/admin` health panel now covers all 6 MCPs + gateway + databases + per-user channel liveness; (6) client watchdog rewritten — liveness-aware, reads the health file, pushes the user via FCM when the session is dead (can't restart Claude in nohup without TTY), stops the 2-min restart spam.
- 2026-04-10: Fix escalation message scoping: recent messages now filtered to the specific conversation (was returning messages from all conversations). Escalation header now shows resolved contact name + chat type (1:1 vs group). JID format note added to CLAUDE.md.
- 2026-04-10: Fix contact link popover z-index: search box was hidden behind header row and sibling rows. Added z-50 to wrapper when open.
- 2026-04-10: People page: server-side search (ES full-text via MCP query param, 300ms debounce), prev/next pagination (24/page), fetch limit 200 (was 50 default).
- 2026-04-10: WhatsApp contact name enrichment: (1) webhook now enriches contacts from group messages too (participant + participantAlt for LID→phone mapping), (2) Evolution API webhook subscribed to CONTACTS_UPSERT + CONTACTS_UPDATE events with gateway handler, (3) backfill_contact_names MCP tool scans Evolution message history (24K+ messages) to extract pushNames for nameless contacts.
- 2026-04-09: Fix WhatsApp image download: gateway was passing encrypted Evolution API key to getBase64FromMediaMessage (regression from api_key encryption). Added decrypt util + ENCRYPTION_KEY env var to gateway.
- 2026-04-09: Android phone contacts push: ContactsRepository reads device address book (ContactsContract), pushes name→phone pairs as phone_contact webhook items. Gateway normalizes phone numbers (Israeli +972/0 variants), enriches messaging_contacts display_name where current name is null/phone-number/JID.
- 2026-04-09: Contacts & Routing: person-first auto-match with Hebrew-Latin cross-script matching (~80 Israeli name lookup table), multi-candidate UI, link contact from People tab via search modal, "Named only" filter (excludes JIDs/phone numbers), client-side pagination (50/page), calendar event cleanup (delete phone events removed from calendar)
- 2026-04-08: Android: alert vibration bypasses silent mode (Vibrator.vibrate), data source toggle sync via device commands, calendar push window reduced (1+14 days, was 7+60), device_calendar webhook items accepted
- 2026-04-08: Admin log overhaul: Datadog-style LogExplorer with faceted sidebar, time range presets, sortable columns, search, slide-out detail panel. Separate /admin/logs and /admin/audit. "Only" button on facets.
- 2026-04-08: Tech debt: 362 tests across 8 packages (was 0). Auth-middleware deduplicated (4 copies → @ll5/shared). Logging format fixed (shared 0% → 100%).
- 2026-04-08: User management: all 5 phases — AsyncLocalStorage (6 MCPs), DB migration 019, admin CRUD API (10 endpoints + dashboard), username login, rate limiting, PIN validation (6+ blocklist), multi-user schedulers, WhatsApp routing, onboarding wizard, families tables
- 2026-04-07: Data source config: per-source toggles (GPS, IM, calendar, health, WhatsApp) in user_settings JSONB. Gateway isSourceEnabled() helper with 60s cache. Enforcement in processItem + WhatsApp webhook. Dashboard /settings/data-sources page with toggle switches.
- 2026-04-07: Health polling scheduler: polls ES every 20min during active hours, detects new sleep/activity/HR anomaly/stress/energy/weight events, batches into system messages with notification levels. 7-day baseline for conditional alerts. Dedup per day.
- 2026-04-07: Source routing metadata on system messages: WhatsApp webhook includes platform/remote_jid/sender in metadata, PG NOTIFY passes it through, channel MCP exposes it in meta.source. Agent instructions updated: MUST reply on the same platform using send_whatsapp with remote_jid.
- 2026-04-07: Contacts page: instant optimistic UI (fire-and-forget server updates, no blocking), sessionStorage cache (instant paint on revisit, background refresh if stale >5min)
- 2026-04-07: Fix WhatsApp sync: re-encrypt Evolution API key (was stored as plain text), synced 2,874 contacts with names. Auto-match UI shows phone number + KB person notes for better match verification.
- 2026-04-06: Contact matching UI: link popover (search KB people), unlink button per platform, auto-match wizard (fuzzy name matching with accept/skip)
- 2026-04-06: WhatsApp webhook enriches contact display_name from pushName (only overwrites null/empty/phone-number-only names)
- 2026-04-06: Fix CI deploy: add docker login to GHCR before pull (server auth was expiring, causing deploys to skip image updates silently)
- 2026-04-06: Unified contacts system: Person `status` field (full/contact-only), 3-tab Contacts & Routing page (People, Contacts, Groups). Unlinked messaging contacts get lazy-created stub persons on first setting change. Promote button moves contact-only → full KB person. Gateway matcher unchanged — all routing via person_id.
- 2026-04-05: 100% audit logging across all MCPs (personal-knowledge, awareness, health, messaging). Audit log entity IDs are hoverable with detail tooltips. Gateway initAudit ready for server-side processors.
- 2026-04-05: Fix export (per-index limits, no media, request timeouts), fix WhatsApp image download (pass full message to Evolution API)
- 2026-04-05: User model versioning (history index + list/get version tools), consolidation reloads model + pushes silent update, GPS accuracy filter (>100m discarded)
- 2026-04-05: 100% tool logging: add withToolLogging + initAppLog to personal-knowledge and messaging MCPs (were missing entirely). All 6 MCPs now log every tool call.
- 2026-04-05: Map z-index fix, places page map view (list+map split with Leaflet), data export page (/export), location query returns doc IDs for delete_location_point
- 2026-04-05: Geo search tools on awareness MCP: search_nearby_pois (Overpass), geocode_address (Nominatim), get_area_context, get_distance (OSRM). Plus delete_location_point for GPS error cleanup.
- 2026-04-05: Calendar week view: timeline layout with hour grid, work hour coloring, current time line, respects week start day from profile settings
- 2026-04-04: Proactive agent overhaul: audit trail (correlation IDs on all scheduler messages), data-rich heartbeat (events past+future + pending counts), configurable scheduler settings UI (/settings/scheduler), all intervals readable from user_settings JSONB
- 2026-04-04: Agent nudge scheduler, recurring ticklers, conversation escalation, Garmin body battery/HRV/VO2 Max, work week settings
- 2026-04-03: Design docs for roadmap items, unified user_settings, notification levels, archived groups, places auto-geocoding
- 2026-04-01: Journal consolidation, chat SSE, chat progress feedback
- 2026-03-31: Health MCP + dashboard, media gallery, unified message priority, check_availability
- 2026-03-29-30: Calendar integration, Android app, channel MCP bridge, dashboard pages, audit log
- 2026-03-28: Infrastructure: Coolify, auth, MCPs built + deployed, chat system
- 2026-03-27: Project start: design docs, monorepo foundation

## Known Issues

Moved to **[docs/ISSUES.md](ISSUES.md)** (2026-09-04) — the single living register. The three bullets that lived here are ISS-K01..K03 there. Closing an issue = flip its row there + a dated entry here, same commit.

















_(2026-05-24 cont.) Garmin reconnected; deviceregistration confirmed name-only (no battery) — added getDeviceStatusProbe (mylastused + primary-training-device) to locate the live battery field via calibration log._

_(garmin battery hunt probe)_

### Web chat: Markdown rendering for agent messages (2026-05-24)
Agent messages were rendered as raw text, so Markdown tables (`| … |`) and `**bold**` showed literally. Added GFM Markdown rendering on the dashboard chat (`react-markdown` + `remark-gfm` tables + `remark-breaks` to keep soft line breaks) via `components/chat/markdown.tsx`, themed to the ink/coach palette (tables scroll horizontally, `dir=\"auto\"` per block for RTL). Wired into `message-bubble.tsx` for assistant messages (unboxed + bubble variants); user messages stay plain text. Dashboard typecheck clean. (Android equivalent next.)

### Phone photos: gateway ingest (camera_photo) (2026-05-24)
New capability — agent access to photos taken on the phone, matched to day events. **Reuses the existing media system** (ll5_media + awareness media tools). Gateway side: added `camera_photo` push type (`push-data.ts`) + `processors/camera-photo.ts` → indexes into `ll5_media` (source:camera, with `taken_at` + `lat`/`lon` for event-matching) and posts a concise `[Photo]` system message so the agent can react proactively-but-selectively (decided: full-image upload + proactive-smart). Gated by `data_sources.camera_photos`. Google Photos API is NOT viable (restricted to app-created media since Mar 2025) — on-device MediaStore is the source. Android capture + persona next. 181 tests pass.
- 2026-07-04: bw CLI pinned 2024.4.1 in Dockerfile.vault (newer CLIs need userDecryptionOptions Vaultwarden doesn't send for --apikey login); vaultwarden Traefik labels renamed vaultwarden-web-* + traefik.docker.network=coolify (ll5-vault name collision had merged its service with the vault MCP's — mcp-vault served Vaultwarden 404s)
- 2026-07-04: reply/reaction anchoring — WA quoted-reply context extracted (processors/whatsapp-webhook.ts contextInfo → '[replying to: «…»]'), channel resolves reply_to_id/reaction targets to content snippets, new get_message channel tool resolves any message UUID
## Agent-liveness watchdog (2026-07-09)
- New `docker/agent-watchdog.sh` — systemd-timer-based watchdog that checks agent health via `docker inspect` (primary) and direct HTTP `:4096` (fallback).
- Raises system alerts through the gateway's `POST /alerts` endpoint (new) → existing alert spine → FCM push to phone + [ALERT] system message.
- Watchdog operates independently of the agent runtime: generates short-lived `ll5.` auth tokens from `AUTH_SECRET` extracted via docker inspect of the gateway container.
- `docker/ll5-watchdog.service` + `docker/ll5-watchdog.timer` — 5-minute timer, deployed to `/etc/systemd/system/` on production server.
- Verified: watchdog status, auth token generation, Docker container health detection all working. Full alert → FCM pipeline verified after CI deploy.
- **2026-07-09 fix:** AGENT_VARIANT was `claude` on production → OPENCODE_SERVER_URL was empty → gateway never triggered agent for user messages. Fixed to `opencode` in .env, set `AGENT_VARIANT` GitHub secret, stack restarted, prompt_async test passes (HTTP 204).
- **2026-07-09: Zen API key + DeepSeek v4-pro** — switched from free-tier `opencode/deepseek-v4-flash-free` to paid `opencode/deepseek-v4-pro` via user's Zen API key. Updated opencode.json in `ll5-run-opencode` repo ([3c49258](https://github.com/arnonzamir/ll5-run-opencode/commit/3c49258)), rebuilt image, deployed. Gateway env: `OPENCODE_MODEL_ID=deepseek-v4-pro`, `OPENCODE_PROVIDER_ID=opencode`. API key stored as `OPENCODE_ZEN_API_KEY` GitHub secret.

## Variant wiring (2026-07-08)
- gateway env: OPENCODE_SERVER_URL=http://agent:4096, OPENCODE_MODEL_ID=deepseek-v4-pro, OPENCODE_PROVIDER_ID=opencode
- agent container: ssh:2222 + opencode serve:4096, both healthy
- Old Claude container (js8owk0g0...) stopped and removed.

## CI build fix (2026-07-09)
- `VARIANT_REPO_READ_PAT` GitHub secret was missing → `actions/checkout@v4` failed with "Input required and not supplied: token" when checking out variant repos (run-claude, run-opencode).
- Set the secret using local `gho_` token (has `repo` scope, validates for Git operations).
- Also fixed `docker/Dockerfile.ll5-run-claude`: `hooks/` path was `variant-content/hooks/` but the claude variant repo has it at `.claude/hooks/`; `tmux.conf` was missing from the variant repo entirely — changed to generate a minimal default via `RUN` command.
- Variant Docker builds also failed because `MCP_BASE_DOMAIN` env var wasn't passed (render-mcp-config.ts requires it). Added `ARG MCP_BASE_DOMAIN` to both Dockerfiles + `build_args` in CI workflow. Also removed variant packages from on-push build matrix (variants have their own CI in their own repos; GHCR push from ll5 repo gets 403 for ll5-run-opencode).

2026-07-09T00:24:40: deploy: OPENCODE_MODEL_ID + OPENCODE_PROVIDER_ID env injected

## 2026-07-12 — Audio transcription key live

GROQ_API_KEY wired end-to-end (CI secret + deploy .env injection). Groq whisper-large-v3 verified transcribing. transcribe_audio now functional once the deploy lands + agent re-provisions.

---

## 2026-07-12 — anthropic-direct model ids corrected

agent-models.ts + opencode.json now use the real Anthropic API ids (claude-haiku-4-5-20251001, claude-fable-5). Groq key can be set per-tenant via the new keys UI.

---

## 2026-07-12 — strict per-tenant keys

Removed the system-wide GROQ_API_KEY fallback from secrets.ts — provider keys are now strictly per-tenant (each tenant BYO-keys via the keys UI). All model config (keys, default, per-slot) is per-user in agent_llm_credentials.

---

## 2026-07-12 — topics "Recent" sort fix

Active-topics "Recent" sorted by the stale denormalized last_observed_at (lags consolidation), so it mis-ordered / dropped genuinely-active topics. Now pulls a candidate window, overwrites with the LIVE max(observed_at), and sorts by that. In personal-knowledge narrative.repository.

---

## 2026-07-12 — deploy pulls agent-orchestrator

The deploy pre-pull loop omitted agent-orchestrator, so compose up ran a stale local image and the control plane never picked up code changes (multi-provider config was inert until a manual recreate). Added it to the loop.

---

## 2026-07-13 — idempotent provision (fix Re-provision 409)

Dashboard Re-provision / Save-models provisions without a preceding stop, so it 409-conflicted on the existing container name. DockerRuntime.provision now force-removes any container holding the target name before create.

---

## 2026-07-13 — AGENT_IMAGE_ANTHROPIC

Set AGENT_IMAGE_ANTHROPIC=ghcr.io/arnonzamir/ll5-run-claude:latest so the orchestrator can provision the Claude variant.

---

## 2026-07-13 — claude image missing curl (ll5-server crash)

Dockerfile.ll5-run-claude installed only tmux/wget/ca-certificates. ll5-server pings the gateway with curl → "curl: command not found" → error-loop, never launched claude. Added curl + jq + git + procps + python3.

---

## 2026-07-13 — runtime panel shows live config + claude heartbeat

Hosted-runtime panel showed stale legacy provider/model. Now shows the live model_config (variant + resolved main model + per-slot). Claude variant got a heartbeat loop (was showing heartbeat_stale/Error despite running).

---

## 2026-07-13 — claude channel MCP deps (real-time inbound)

Dockerfile.ll5-run-claude copied channel/ but never npm-installed it, so the ll5-channel MCP crashed (ERR_MODULE_NOT_FOUND @modelcontextprotocol/sdk) → no real-time gateway SSE inbound (only scheduled batches). Added npm install in /workspace/channel. Entrypoint also now includes ll5-channel in the generated .mcp.json.

---

## 2026-07-13 — reply 500 + SSE silence (orphan conversation writes)

Replying to a conversation_id with no chat_conversations row let the notify_chat_message trigger INSERT a SECOND active conversation → violated idx_chat_conversations_one_active → the whole insert (incl. its pg_notify → SSE) rolled back with 500. resolveWriteTarget now reroutes non-existent unified-channel ids to the active conversation. Fixes both the 500 and the missing real-time SSE for those writes.

---

## 2026-07-13 — thinking-indicator auto-clear backstop

"coach is thinking" is cleared by an assistant message over SSE; a stale/disconnected EventSource left it stuck forever. Added a 120s auto-clear timeout in setThinking. (Backend SSE verified healthy — the stick was a client stale-stream state.)

---

## 2026-07-13 — worker panel heartbeats (claude workers + main)

Claude -p worker loops now POST /internal/agent-session after each tick (narrative/reconcile) so the Workers panel shows them live (verified narrative fresh). /me/agent/heartbeat now also bumps the MAIN session heartbeat so "Interactive" stays fresh (both variants). Also: IS_SANDBOX=1 in the claude entrypoint so claude -p workers can run as root.

---

## 2026-07-13 — claude voice (faster-whisper) restored

The claude variant transcribes voice notes on-box with faster-whisper (private — audio never leaves the container) via scripts/transcribe.py + a CLAUDE.md bash instruction; image reading uses Claude native vision (inspect_image returns the image). The current image was missing the faster-whisper package (only python3 was installed) → transcribe.py failed. Dockerfile.ll5-run-claude now pip-installs faster-whisper + pre-downloads the small model to a baked HF_HOME (/opt/hf-cache, not the shadowed /data/home volume).

---
