# DECISION-017 — Recent sessions in recall by default + read-the-week on recovery

Status: accepted — 2026-06-28

## Context

Investigation into the agent's "getting lost after restart" feeling found the cause is not
missing capability but **unused** capability. `recall_everything` is used regularly (115
sweeps / 10 days), but across **all 115 it passed `sources:["session"]` exactly 0 times** —
it has never once searched the raw conversation transcripts (`ll5_session_history`, 199 docs,
indexing healthy, 39 sessions in the last 7 days). Session search was **opt-in and framed as
a noisy last resort**, so the agent always stopped at the distilled stores (facts / journal /
narratives / lessons) — which flatten away the literal "what were we mid-thread on" detail.
At the recovery moment the agent gets distilled narratives injected (DECISION-016 era hook),
feels grounded enough, and never digs into the raw thread.

User directive: *"I prefer the agentic working through muddy sessions than behaving like a
memory-loss patient."*

## Decision

1. **`recall_everything` sweeps recent sessions by DEFAULT.** `ll5_session_history` joins the
   default index set, **time-bounded to the last 7 days** (so old chatter never dilutes
   results) via a per-index `last_message >= now-7d` filter that leaves non-session indices
   unrestricted. New params: `session_days` (default 7) to widen, `all_sessions:true` to drop
   the bound (the liberal fallback). An **empty query** now means `match_all` — paired with
   `mode:"timeline"` it reads back the recent window. The thin-coverage hint flips from
   "re-run with sources:[session]" to "**widen** session_days / all_sessions — dig, don't give
   up."

2. **New `recent_sessions(days, limit)` tool** — one compact row per session (time span,
   message count, opening line; no transcript bodies) — the "map" of the last week.

3. **Recovery reads the week.** `session-start.sh` injects a 7-day session digest (via
   `recent_sessions`) on **every** start, with a dig-in directive; the **compact** branch adds
   a forceful "you just lost your working thread — read the last 7 days before acting." Persona
   Hard Rule 12 updated: recall includes recent sessions by default; after restart/compaction,
   read the week back before acting.

## Alternatives considered

- **Keep session opt-in, just nudge harder in the persona.** Rejected: the persona already
  *mentioned* the session source and it was used 0/115. A default-on policy change is what
  moves behavior; nudging a discouraged opt-in does not.
- **Inject the full last 7 days of raw transcripts at every session start.** Rejected:
  100k+ tokens into every session's context, permanently — impractical and self-defeating. The
  agentic read (digest map + the agent recalling on demand) matches the "work through muddy
  sessions" intent without bloating the persistent context.

## Consequences

- Every recall now surfaces recent conversational detail; the agent can recover the literal
  thread, not just summaries. The `sess_opt`/`session_searched` watch signal should climb from
  ~0 toward most-recalls.
- Sessions are chatty: the per-source cap (8 in relevant mode) still protects distilled stores
  from being drowned; the 7-day bound keeps the candidate set small.
- **Open follow-up (not built):** if the digest+dig isn't enough and we want the agent to
  cheaply read the *full* week, store a **distilled/token-optimized summary per session** so
  "read 7 days" = reading ~30 short summaries instead of raw transcripts. Deferred until the
  default-on behavior is observed.
