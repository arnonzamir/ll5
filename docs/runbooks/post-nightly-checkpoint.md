# Runbook — post-nightly checkpoint (first run 2026-09-05 03:12 IDT)

Scheduled by Arnon on 2026-09-04 21:55 IDT. Standing authorization for this run, in Arnon's words: *"take a decision there - if everything is fine, move on with the upgrades, no other authorization needed. For minor or mid level decisions - take a reasonable calculated decision, review it with another agent, document it and move on. Stop and wait for me only on critical issues."*

Read first: `docs/HANDOFF.md` START HERE block, `docs/implementation/agent-remediation-2026-09-04.md` status table. Prod ES: `scripts/esq.sh` (path starts with `/`). Agent container: `ssh root@95.216.23.208`, `docker exec ll5-agent-f08f46b3-0a9c-41ae-9e6a-294c697424e4` (home `/data/home`, logs `/data/home/.ll5/`). Session id before the hand-off: `d2148376-4ece-47ab-a231-aeb3df281cfd` (started 2026-09-04 18:27Z).

## Step 1 — verify, in order

1. Nightly hand-off: `session-restart` journal entry after 2026-09-05T02:00 IDT (`topic.keyword=session-restart` in `ll5_agent_journal`) **and** a `FRESH RESTART` line in `/data/home/.ll5/mcp-autoheal-server.log`; `/data/home/.ll5/agent-session-id` differs from the id above.
2. `CONSOLIDATE-TALLY` line in `ll5_agent_journal` from the 02:00 pass: `observations=` > 0; note `resolved=` (ISS-011 signal).
3. `ll5_agent_user_model_history` has a doc with `archived_at` > 2026-09-04T20:00Z (ISS-012).
4. `ll5_turn_costs` count grew since 2026-09-04; `telemetry.turn_costs_stale` not firing.
5. `ll5_knowledge_observations` count for `now-1d` > 0.
6. Alerts: any `agent.*`, `telemetry.*`, `knowledge.*` alert firing since 2026-09-04T18:00Z. The agent answered normally after the restart (a reply in `ll5_chat_messages` or a journal entry after the restart).

## Step 2 — decide

- **Critical — stop, report to Arnon, do nothing else:** restart did not happen **and** the agent is not responding; data loss (journal/observations/user-model empty or overwritten); restart loop; anything security-relevant.
- **Minor/mid — decide yourself:** one check missing while the agent is healthy (tally missing but restart fine; history snapshot missing; `observations=0` on a quiet night). Take a calculated fix or a documented deferral; have it reviewed by **one** reviewer subagent (general-purpose; prompt = finding + proposed decision, ask for risks and a yes/no); document in `docs/ISSUES.md` + dated `docs/PROGRESS.md` entry; commit, push; continue to Step 3 unless the reviewer flags it critical.
- **All fine:** Step 3.

## Step 3 — Phase 5 runtime upgrade (authorized tonight; overrides the plan's "after a clean 7-day baseline")

a. Freeze the pre-upgrade control: `scripts/agent-baseline.sh --since 2026-09-04 --until 2026-09-05 > docs/reviews/2026-09-05/agent-baseline-pre-upgrade.md`.
b. `npm view @anthropic-ai/claude-code version` → bump `ARG CLAUDE_CODE_VERSION` in `docker/Dockerfile.ll5-run-claude`. Agent repo `/Users/arnon/workspace/ll5-run-claude-code`: `ll5-server` `COMMON_FLAGS` `--model claude-opus-4-7` → `claude-opus-5` (the narrative loop's `claude-sonnet-4-6` stays — document as a deliberate deferral). Commit both repos with the standard trailers (`Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`, `Claude-Session: https://claude.ai/code/session_01K1zyJDwv7doFMem6Ly8LtD`); ll5 commits stage `docs/PROGRESS.md`, `docs/HANDOFF.md`, `docs/FILE_TREE.md`. Order: push the ll5 Dockerfile change **with `[skip ci]`** first (a `docker/`-only push rebuilds all infra and skips run-claude), then push the agent repo (its `trigger-ll5-rebuild.yml` dispatches `package=run-claude`, which builds from ll5 `main` — so the pin must already be on `main`). Never push a package change while a deploy is in flight; `gh run watch <id> -R arnonzamir/ll5 --exit-status`.
c. Verify **inside** the container after the roll: `docker logs ll5-agent-<uid>` shows `claude version OK: <new> == pin <new>`; `claude --version`; `ps` shows `ll5-server` launched with `--model claude-opus-5`; the agent answers (next scheduler turn → reply or journal entry); `context-pack.log` and session-start ran; no `/data/home/.ll5/version-mismatch`. If the build fails on the version (npm install, verify step), pick the newest version that installs and document it.
d. Docs: `docs/ISSUES.md` ISS-007 row (pin now `<new>`); `docs/PROGRESS.md` "Phase 5 runtime upgrade"; `docs/HANDOFF.md` START HERE (image `<new>`, model `claude-opus-5`, next: 7-day diff on 2026-09-12 with `scripts/agent-baseline.sh --since 2026-09-05 --until 2026-09-12`); status table Phase 5 row. Commit, push (docs-only).
e. Schedule the next checkpoint: 2026-09-06 03:12 local, Step 1 again (post-upgrade first night), same authorization rules.

## Rules

No emojis. Never print secrets. Report outcomes faithfully — a failed check is stated with its decisive line. Verify inside the container, never trust `deploy: success`. Each agent roll starts a fresh session (~$5.5 cold start): at most **one** roll tonight. Finish with a short status table: each Step 1 check (pass/fail + evidence), the decision class, what was upgraded, and what — only if critical — waits for Arnon.
