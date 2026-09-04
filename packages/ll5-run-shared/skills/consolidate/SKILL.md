---
name: consolidate
description: Nightly consolidation + PRE-STAGE engine — merge the day's journal, promote repeated corrections to durable stores, and ground the next ~14 days of upcoming items into injected memory so the day runs warm. Gated by the grounding-reviewer before anything durable is written.
---

# Journal Consolidation + Pre-Stage

Two jobs, run nightly (or on demand):

1. **Look back** — consolidate the day's journal, update the user model (the original job).
2. **Look forward** — for the next ~14 days, ground each upcoming item against everything we know and
   **pre-stage** that grounding into injected memory, so during the day the facts are already in context
   instead of being (re)discovered or, worse, missed. This is the fix for "data existed in a store but
   never surfaced when needed."

Everything durable you write here — promotions and pre-staged groundings — passes through the
**grounding-reviewer** subagent first (Step 4). You draft; it audits; you commit only what survives.

---

## Step 1 — Look back: consolidate the day

1. **Load raw entries**: `read_journal(status: "open", limit: 100)`.
2. **Consolidate by topic**: merge related entries into one concise `write_journal(type: "observation", topic, content, signal: "consolidated")` and `resolve_journal` the sources. Consolidate, don't append. Be shorter than the sum of sources.
3. **Update stable user-model sections** with what was genuinely learned today (`communication`, `relationships`, `routines`, `goals`, `work`) — only the sections that changed; merge into existing content, don't rewrite.
4. **Observations for every subject the day named (ISS-002).** For each consolidated topic that names a person, place, group or topic, check `recall({ subjects, since: <today> })`; if the day's events produced **no** `note_observation` for that subject, write one now from the consolidated entry (`subjects`, `text`, `source: "journal"`, `source_id: <journal id>`). The narratives and the knowledge base are built only from observations — a day that lives only in the journal is a day the system forgets.

## Step 2 — Promote on repetition

A correction or fact you've now seen **≥2 times** in the volatile journal has earned a stable home — leaving it in the journal means re-learning it (or forgetting it) every cycle.

1. Scan the recent journal (this pass + recent consolidated entries) for **claims that recurred ≥2×** — a correction the user gave more than once ("that's Rotem's, not mine"; "I don't go to the Sunday Summit"), a stable preference, a relationship/routine fact repeated across days.
2. For each, **draft a promotion** into the right durable store:
   - a relationship/ownership fact → `relationships` (user_model) or a person note / fact via personal-knowledge;
   - a routine/preference → `routines` or `communication` (user_model);
   - a durable life fact → a `fact` (personal-knowledge).
3. Don't commit yet — promotions go to the reviewer in Step 4. (One-off, single-mention items stay in the journal; promotion is for the *repeated*.)

## Step 3 — Look forward: pre-stage the next ~14 days

The point: when an upcoming event/commitment/person becomes live during the day, the grounding is **already in context** — who it involves, whether it's even the user's, the history, the prep it needs — instead of the agent guessing or asking.

1. Pull the window: calendar `list_events` (next ~14 days) + `list_ticklers` (same window) + open commitments from the journal.
2. **For each upcoming item, run `recall_everything({ query: <title + people + key terms> })`** — one sweep gathers facts, people, journal (topic *and* content), past corrections, related messages, prior instances. Widen to `sources:["session"]` / `get_person` / `recall` when the sweep is thin and the item matters.
   - **For a status-dependent item** — a pickup, a delivery, an errand that may already be *done* — use **`mode: "timeline"`**: the decisive recent update ("picked up Friday") is exactly what relevance ranking buries under the verbose original ("ordered, 2,700 NIS, ready in 2 weeks"). And if a default sweep returns `more_available` (a source had more matches than it showed), re-run timeline before you pre-stage a state — a half-seen history pre-stages a wrong "fact" for days.
3. From each sweep, **draft a one-line grounding**: who/what it involves, **whose it is** (the user's vs a spouse's/group's — the `סרט יועצים` trap), any prior correction about it, and the prep it implies. Mark items where the sweep found **nothing** — those are genuine unknowns to leave open (and maybe a light question for the day), not gaps to fill with a guess.

## Step 4 — Review gate (mandatory before any durable write)

Hand the **drafted promotions (Step 2) + pre-staged groundings (Step 3)** to the independent auditor:

```
Task(subagent_type: "grounding-reviewer", prompt: <a JSON list of the drafted items, each with
  { claim, subject, intent: "promote_to_store" | "pre_stage" }>)
```

The reviewer re-verifies each item from scratch with its own `recall_everything` sweeps and returns a
per-item verdict (KEEP / FIX / DROP) with the grounding source. **Apply it:**
- **KEEP** → commit as drafted.
- **FIX** → commit the reviewer's corrected version.
- **DROP** → do not write it. (If it was a pre-stage, either drop it or carry it as an explicit unknown.)

A DROP is a save, not a failure — it's a confabulation or a misattribution caught before it became a
"fact" you'd act on for days.

## Step 5 — Commit

1. **Pre-staged groundings → injected memory.** Write the surviving groundings into `active_context` as a
   dedicated `upcoming_grounded` field — `active_context` is volatile and replaced each pass, which exactly
   matches the rolling window, and it's already injected at session start so the day runs warm:
   ```
   write_user_model(section: "active_context", content: {
     hot_topics: [...], current_mood: "...", recent_corrections: [...],
     this_week_focus: [...], pending_commitments: [...],
     upcoming_grounded: [ { when: "...", item: "...", grounding: "<who/what/whose/prep>", source: "<store>" }, ... ]
   })
   ```
   Keep it tight — the highest-value items for the next few days, not all 14 days of noise. Drop stale ones each pass.
2. **Promotions → their durable stores** (the reviewer-approved versions), then `resolve_journal` the source entries that are now promoted.
3. **Journal the pass**: one `write_journal(type: "context", topic: "consolidation-pass")` whose content STARTS with a machine-readable tally line, then the prose:
   ```
   CONSOLIDATE-TALLY consolidated=<n> resolved=<n> observations=<n> promoted_facts=<n> promoted_people=<n> user_model_sections=<n> prestaged=<n> reviewer_dropped=<n> reviewer_fixed=<n>
   ```
   The anomaly monitor and the baseline re-measure read this line — it is how "did the nightly pass actually promote anything" becomes a number instead of a feeling.
4. **Hand the day over (controlled daily restart, ISS-016).** As the very last step, `Bash: touch ~/.ll5/restart-requested`. The in-container watcher then restarts you into a **fresh session** at the next idle moment (within minutes): the previous session's tail is in `recent_sessions`, `active_context` is what you just wrote, and SessionStart re-grounds from the stores. This is deliberate — it keeps the context small and the grounding fresh, instead of a 7-generation compaction chain. Do not skip it.

---

## Rules

- **Draft → review → commit.** Nothing durable (promotion or pre-stage) is written before the
  grounding-reviewer has passed on it. The reviewer is read-only; you do the writing, on its verdict.
- **Pre-stage is grounding, not prediction.** Only stage what a sweep actually returned. An item the sweep
  came up empty on is an *unknown* to carry openly — never a gap to fill with a plausible guess (Hard Rule 12).
- **active_context is volatile** — replace it entirely each pass, including `upcoming_grounded`. Stable facts
  belong in the topic sections / facts, not here.
- **Promote the repeated, not the one-off.** ≥2 mentions earns a durable home; a single mention stays in the journal.
- **Consolidate, don't append. Be concise. Don't hallucinate** — only what was actually observed, said, or retrieved.
