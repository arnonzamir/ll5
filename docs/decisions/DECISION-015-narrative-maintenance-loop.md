# DECISION-015 — Async narrative maintenance loop (dedicated ephemeral worker)

Status: in progress (design 2026-06-24)
Date: 2026-06-24

## Context

Living Narratives (DECISION-014) shipped the substrate, the relevance/edge surfaces,
the UI, and a **freshness loop**: a gateway scheduler that selects narratives needing
work and nudges the agent via a `[Narrative Freshness]` system message. The detection,
scheduling, and selection are all correct — but the *execution* is unreliable:

- The **live agent only does ~1–2 consolidations per nudge.** It prioritizes real-time
  life and won't grind a silent multi-item chore, even at idle hours with small batches.
- To accommodate that, every selection knob was tuned *down*: orphan promotion needs
  ≥3 observations, only 5 refresh + 4 create per nudge, 6h debounce, top-of-hour gating.
  So **net-new people/topics with only 1–2 observations never become narratives** —
  the "many things I dealt with today aren't there" symptom.

Earlier on 2026-06-24 we tried delegating the chore to a `narrative-consolidator`
subagent the live agent spawns on the nudge. Better, but it still rides the live
agent's thread (it must notice the nudge and fire the Task) and still pollutes that
thread with the work-list. The user's framing: **make narrative maintenance an
asynchronous loop, completely off the main agent, and much more sensitive than now.**

The key realization: **the sensitivity was capped *because* the live agent was the
bottleneck.** Remove the live agent from the loop and the caps can come off.

## Decision

Run narrative maintenance as a **dedicated, self-pacing loop inside the agent
container, executed by an ephemeral `claude -p` worker** — fully decoupled from the
live conversational agent.

```
  narrative-loop.sh  (external sleep-loop, ~20 min cadence)
        │  every tick:
        ▼
  claude -p  (ephemeral, headless, sonnet, minimal MCP set)   ← the dedicated brain
        │  1. list_narrative_work  → sensitive {stale, orphans} work-list
        │  2. for each: consolidate_narrative → upsert_narrative (last_consolidated_at)
        │  3. one batch journal note
        ▼  exits (frees all resources until next tick)
```

The loop **drives itself** (the sleep-loop is the clock), does its work in a process
**separate from the live agent** (non-blocking by construction), and is as **sensitive**
as we want because a dedicated worker can't "balk" the way the busy live agent does.

### Why an ephemeral worker, not `/loop`-proper (ScheduleWakeup)

The user asked: can we use `/loop`? `/loop` is Claude Code's self-pacing loop — a
session schedules its own next wake via `ScheduleWakeup` and repeats. It's a clean fit
for the *timer*, but it requires a **persistent** session: ScheduleWakeup re-invokes a
*living* session, and a one-shot `claude -p --print` **exits** after responding, so
ScheduleWakeup never applies to it.

So `/loop`-proper would mean a **second always-on `claude` process** dedicated to
narratives. On this shared, resource-contended box (see the host-pressure incidents)
a standing second agent — process + 6 MCP connections + context held 24/7 — is a real
cost for work that runs ~2 minutes every 20.

The external **sleep-loop + ephemeral worker** gives the *same* behavior (self-paced,
dedicated, off the main agent) at ~10–15% duty cycle: each tick spins a worker that
does its job and **dies**, freeing everything between runs. It is also **crash-robust**
(a failed run doesn't break the loop — the next tick fires fresh, no session to re-arm)
and **version-independent** (depends only on well-supported headless flags, not on the
`/loop` skill). The container runs `claude 2.1.138`, which has full headless support
(`--print`, `--permission-mode`, `--agents`, `--max-budget-usd`, `--fallback-model`,
`--no-session-persistence`).

Net: we honor the "make it a loop" intent with the lighter implementation. If we later
want true in-Claude self-pacing, `/loop` on a dedicated session is the upgrade path.

### Sensitivity (the "much more sensitive" part)

Because the dedicated worker absorbs volume, the selection comes off its leash:

| Knob | Old (live-agent nudge) | New (dedicated loop) |
|------|------------------------|----------------------|
| Orphan promote threshold | ≥3 observations | **≥1** (any touched subject with no narrative) |
| Per-cycle batch | 5 refresh + 4 create | bounded by a safety `max` (~25), drained over cycles |
| Cadence | every 3h, 07–22, top-of-hour | **every ~20 min, around the clock** |
| Refresh debounce | 6h | **~45 min** (coalesce bursts, still responsive) |
| Driver | live agent (skips it) | dedicated worker (can't balk) |

The first runs **backfill**: every subject touched in the window (default 14 days) with
no narrative gets one created, drained `max` per cycle until the backlog clears; steady
state then handles only newly-active/new subjects each tick. Dedup is automatic — a
narrative whose `last_consolidated_at` is past its latest observation is skipped, so an
overlapping scan window never re-does fresh work.

### Components

1. **`list_narrative_work` tool** (personal-knowledge MCP) + repo method
   `selectConsolidationWork(userId, {windowDays, promoteThreshold, debounceMinutes, max})`.
   Returns `{stale, orphans}` computed against the **live `max(observed_at)`** (never the
   denormalized `last_observed_at`), the same canonical logic the gateway scheduler used,
   now in the repo and sensitivity-parameterized. This is the worker's single read.
2. **`.mcp.narrate.json`** (ll5-run) — minimal MCP set for the worker: **personal-knowledge
   + awareness** only (consolidation tools + `write_journal`). Cuts per-run MCP warmup
   from 6 servers to 2.
3. **`prompts/narrative-loop.md`** (ll5-run) — the worker's task prompt (the consolidation
   procedure; mirrors the `narrative-consolidator` agent, tuned to "call list_narrative_work
   first, then work the whole list, silent, one journal note").
4. **`scripts/narrative-loop.sh`** (ll5-run) — the sleep-loop driver: `nice`/`ionice` (yields
   to the live agent per the shared-box priority rule), a single-flight lock (never overlap
   runs), sources the gateway token env, launches `claude -p` with sonnet + `--max-budget-usd`
   cap + `--permission-mode acceptEdits` + `--no-session-persistence` + `--mcp-config
   .mcp.narrate.json`, logs to `$HOME/.ll5/narrative-loop.log`.
5. **docker-entrypoint.sh** — start `narrative-loop.sh &` alongside the MCP-autoheal watcher.
6. **Gateway heartbeat disabled** — the `narrative-consolidation` scheduler default flips to
   **off**, so the loop is the sole active driver and the live agent's thread stays clean.

### What happens to the earlier (live-agent subagent) path

Left in place but **dormant**: the `narrative-consolidator` subagent, the channel
`[Narrative Freshness]` dispatch entry, and the gateway nudge text all remain. With the
gateway heartbeat disabled they simply never fire. They become a **re-armable fallback**:
if the loop ever fails, flipping `narrative_consolidation_enabled=true` restores the
live-agent path with one config change. No code is deleted.

## Alternatives considered

- **`/loop`-proper (persistent dedicated session).** Cleanest self-pacing, but a standing
  second `claude` on a contended box. Rejected for resource cost; kept as the upgrade path.
- **`/loop` on the live agent.** Stays "inside main claude-code," but the clock then depends
  on the *busy* agent re-arming each wake — the exact fragility we're removing — and wakes
  interleave with its real-time role. Rejected.
- **Keep live-agent trigger, just sensitize.** Smallest change, but still rides the live
  thread and depends on the agent firing the Task. Rejected (it's the thing the user wants
  off the main agent) — but retained dormant as the fallback above.
- **Direct-API Node worker in the gateway.** Most decoupled and controllable (tail the
  observation stream, near-real-time), but genuinely new infrastructure: an API key in the
  gateway, a bespoke tool-call loop, and the summarization prompt living outside the agent.
  Rejected for now (reuses nothing); revisit if the ephemeral-worker cadence proves too coarse.

## Consequences

- **Positive:** narratives become genuinely live and sensitive (every dealt-with subject
  surfaces), the live agent is never burdened or polluted, the worker is cheap and
  crash-robust, and the whole thing reuses existing infra (same container, MCPs, auth).
- **Cost:** an ephemeral `claude -p` every ~20 min — ~70–100 short sonnet sessions/day. Bounded
  by `--max-budget-usd` per run and `nice`/`ionice` so it yields to the live agent. Each run
  pays a ~2-MCP warmup.
- **Operational:** a new background process in the agent container (mirrors the autoheal
  watcher); logs at `$HOME/.ll5/narrative-loop.log`. Restarts with the container.
- **Rollback:** remove the entrypoint line (or `pkill -f narrative-loop`) to stop the loop;
  flip `narrative_consolidation_enabled=true` to restore the live-agent fallback. Fully
  reversible, no data migration.

## Verification

- `list_narrative_work` returns a non-empty `{stale, orphans}` on the live store (threshold 1).
- A loop tick spawns a worker that creates/refreshes narratives and writes one
  `Narrative freshness: refreshed N, created M` journal note; named narratives'
  `last_consolidated_at` advances.
- Resource: the worker runs `nice`d, doesn't starve the live agent, and the box stays healthy
  across several cycles (watch `narrative-loop.log` + host load).
- Backfill: orphan count trends down over the first cycles as missing narratives get created.
