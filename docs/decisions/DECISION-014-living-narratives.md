# DECISION-014 — Living Narratives: always-fresh, edge-aware, observable

Status: in progress (Phase 1 shipped 2026-06-23)
Date: 2026-06-23

## Context

The agent's biggest reliability gap is **on-the-fly context building**: when a
message or wake arrives, it reconstructs "who is this, what's the open thread, who
else is involved" from fuzzy ES recall + prose narratives, every time — and under
load (e.g. a fast-moving group thread) it sometimes reacts in isolation and misses
the connection.

Two explorations (a per-message "context wrapper", then a "graph DB / relationship
map") both collapsed to the same conclusion: **we already have the right data model
— `narratives` (personal-knowledge MCP)** — and the actual gaps are operational:

1. Narratives go stale — refresh was once/day at 3am and agent-discretionary.
2. No relevance ranking — `list_narratives` sorted only by `last_observed_at`.
3. No edges/"map" — `participants[]`/`places[]` exist but no API surfaces the
   connections between narratives; co-occurring observation subjects are never
   exposed.
4. Not observable — the user can't see/steer what the agent knows.

A narrative IS the "context card": `subject {person|place|group|topic}`, `summary`,
`openThreads[]`, `participants[]`, `places[]`, `recentDecisions[]`, freshness
timestamps, `status active|dormant|closed`, one doc per `(user, subject)`. The raw
substrate is the append-only `observations` index.

## Decision

Build **Living Narratives**: turn narratives into a living, edge-aware substrate and
give the user a window onto it. NOT a new store, NOT a graph engine — narratives
(ES) stay the source of truth; edges + relevance are **derived on read**.

Confirmed product decisions (2026-06-23):
- **Build order:** substrate first, UI second (UI must never render a misleading
  stale/edgeless view).
- **Freshness:** debounced/cadenced. Server-selects stale-active narratives every
  few active-hours and refreshes them, debounced so a fast thread is one rewrite per
  window, not many. The detail timeline shows raw observations live regardless, so
  the UI is never stale even if the prose summary lags < the interval.
- **"Summarize now" button:** ephemeral snapshot — the agent produces a point-in-time
  take shown in the UI; it does NOT overwrite the canonical narrative. Keeps the
  manual button read-only and decoupled from the freshness loop (the only writer).
- **Mobile:** simplified — a new "Active" tab listing currently-active narratives,
  tap for plain details + optional Summarize. No graph/timeline pyrotechnics on phone.

## Phases

**Phase 1 — Substrate (personal-knowledge MCP + gateway scheduler). SHIPPED 2026-06-23.**
- Relevance: `narrativeRelevance(n, now)` composite (recency 0.6 / status 0.2 /
  open-threads 0.1 / volume 0.1, ~3-day recency half-life). `list_narratives` gains
  `sort="relevance"` (computed in-app over a bounded candidate window so it reflects
  the LIVE observation count). Also added `place_id` filter.
- Edges/map: `get_narrative_connections(subject)` → entity spokes (participants +
  places, names resolved) + related narratives via shared-participant / shared-place /
  co-subject (co-tagged observations), each with `via[]`, `weight`, `sharedKeys[]`.
  Derived on read; no stored edges.
- Freshness loop: `NarrativeConsolidationScheduler` upgraded from once/day blind nudge
  to cadenced (every `intervalHours`, default 3, within 07–22), **server-selected**
  (queries ES for active narratives with new activity since last summary), **debounced**
  (skip if consolidated within `debounceHours`, default 6). Nudge names the exact
  narratives so the agent consolidates precisely those — no scan.

**Phase 2 — Gateway API (planned).** `GET /narratives` (relevance-sorted, search),
`GET /narratives/:id` (detail + connections + timeline), `POST /narratives/:id/summarize`
(fires an ephemeral agent summary via `insertSystemMessage`, returns `event_id` to
correlate the reply). Proxies the knowledge MCP — one auth surface for web + mobile
(mobile can't do the MCP handshake).

**Phase 3 — Web UI (planned).** Refactor the existing two-route narratives page into
master-detail: left list (search + relevance sort), right detail with a connections
graph (zero-dep SVG radial) + development timeline (CSS rail over observations/decisions)
+ "summarize now" (ephemeral). No new graph lib.

**Phase 4 — Mobile UI (planned, simplified).** New "Active" bottom-nav tab: relevance-
sorted active-narrative list → plain detail (summary, open threads, participants/places
as text, recent activity list) + optional Summarize button. Copy the Approvals slice.

## Alternatives considered

- **Graph DB (Neo4j/Memgraph) / convert stores:** rejected. ES (full-text/geo/fuzzy)
  and PG (ACID/state) are better at what they hold; a graph server on the
  resource-constrained shared box repeats the ES-underprovision tax. Edges are
  derivable on read and the access pattern is "load 2–3 cards", not deep traversal.
- **Per-message prose wrapper ("read as Y, goal Z"):** rejected. Persona/goal are
  already covered (better) by CLAUDE.md + the channel instructions; a rigid per-type
  goal previously CAUSED under-engagement. The valuable kernel — pre-resolved context —
  is the narrative pre-attach (a later step once freshness is trustworthy).
- **Per-event freshness (rewrite on every new observation):** rejected as default —
  high token cost on fast threads. Debounced/cadenced chosen.
- **Persisting the "summarize now" rewrite:** rejected by the user — ephemeral snapshot
  keeps the button read-only and the freshness loop the sole writer.

## Consequences

- Edges + relevance recomputed per read — fine at current scale (dozens of active
  narratives); revisit caching/materialization only if working sets grow large.
- The freshness nudge prefix changed (`[Narrative Freshness]`, names targets). The
  agent reads it as a self-describing instruction; the `narratives` skill still governs
  the consolidate→upsert flow.
- Pre-attaching the relevant narrative into the inbound message (idea #1) is the natural
  follow-on once freshness is proven trustworthy — tracked separately.
