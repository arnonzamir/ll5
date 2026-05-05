# Narratives

The agent's shadow notebook about the user's world.

---

## What this is

A **narrative** is an evolving, agent-maintained understanding of one thread in the user's life — a person, a group, a place, a situation, a topic. It is built mostly from *overhearing* (chat banter, system messages, calendar context, location patterns) and occasionally from explicit user statements.

The user almost never queries narratives directly. They activate **by context match** — when a relevant entity becomes salient in conversation, the agent silently recalls what it knows. The output is contextual memory: *"Tamar had her baby three weeks ago — first one, she was anxious about the delivery."* The agent does not announce this. It just behaves like someone who remembers.

Examples:
- "Tamar's pregnancy and now baby"
- "Itamar's class trip to the north"
- "the family WhatsApp's banter pattern"
- "Rotem's mood lately"
- "the workload squeeze at Sunbit"
- "self-esteem"
- "building a bookshelf"

## Discriminator

| Concept | Subject | Shape | Forward-looking | Pushed at user? |
|---------|---------|-------|-----------------|-----------------|
| journal entry | the agent's own thought | atomic, single moment | no | no |
| user_model | the user (self) | aggregated truth, stable | no | no |
| GTD project | a desired outcome | outcome + next actions | yes | yes (overdue, stale) |
| **narrative** | **anything else in the user's life** | **evolving understanding, threaded across time** | **rarely** | **rarely** |

The clean line:
- **user_model** = what we know about *the user*
- **narratives** = what we know about *everything else in the user's life*

Narratives may overlap with GTD projects ("building a bookshelf" is both), but the framing differs: a project tracks *next actions*; a narrative tracks *the experience of doing it*.

## Mental model

**Listen-mostly, retrieve-by-context, surface-rarely.** The agent writes observations constantly and quietly. The agent reads them whenever an entity becomes salient. The agent rolls them into a summary periodically. The agent pushes the user about a narrative only when something genuinely changed (a long dormancy with new signal, an explicit user question, a contradiction worth surfacing).

A narrative is the only place where *"Rotem seems off this week — could be the new teacher, could be the screen-time fight"* can live. Journal is too granular and not subject-indexed. User_model is too stable and reflexive. Project is too mechanical. Facts are too discrete.

## Subjects

A narrative is *about* one subject. A subject is one of:

| kind | ref | source of ref | examples |
|------|-----|---------------|----------|
| `person` | person_id | personal-knowledge | Tamar, Rotem, Itamar |
| `place` | place_id | personal-knowledge | the office, the cabin |
| `group` | conversation_id (JID for WhatsApp, chat_id for Telegram) | messaging | family group, school parents |
| `topic` | free-text slug | agent-coined | `workload-management`, `self-esteem`, `bookshelf` |

A single observation may carry multiple subjects (a message in the family group about Itamar belongs to both the group narrative and Itamar's narrative). Each narrative summary, however, belongs to exactly one subject.

Topics are agent-coined slugs. No registry table — the slug *is* the identifier. The agent picks slugs deliberately and reuses them.

## Data model

Two layers: observations (the substrate, always written) and narratives (the lazy rollup, written when worth summarizing).

### Observation

Atomic. Append-only. Carries strong provenance.

```ts
interface Observation {
  id: string;                              // UUID
  user_id: string;
  subjects: SubjectRef[];                  // 1..n; first is primary for default routing
  text: string;                            // free-form, agent's words
  
  source: 'whatsapp' | 'telegram' | 'chat' | 'system' | 'journal' | 'inference' | 'user_statement';
  source_id?: string;                      // chat_message id, message id, journal_id, etc.
  source_excerpt?: string;                 // optional: the actual line that triggered this
  
  confidence: 'high' | 'medium' | 'low';   // explicit > implicit > inferred
  mood?: string;                           // free text: "tense", "celebratory", "grinding"
  sensitive: boolean;                      // see Sensitivity section
  
  observed_at: string;                     // when the thing happened (ISO 8601)
  created_at: string;                      // when the agent wrote the observation
}

type SubjectRef =
  | { kind: 'person'; ref: string }        // person_id
  | { kind: 'place'; ref: string }         // place_id
  | { kind: 'group'; ref: string }         // conversation JID/chat_id
  | { kind: 'topic'; ref: string };        // slug
```

### Narrative

Lazy rollup. One per subject. Created/refreshed by `consolidate_narrative` when the agent wants to brief itself fast.

```ts
interface Narrative {
  id: string;                              // UUID
  user_id: string;
  subject: SubjectRef;                     // exactly one
  
  title: string;                           // e.g. "Tamar's pregnancy and baby"
  summary: string;                         // 1-3 paragraphs, agent-rewritten
  current_mood?: string;                   // snapshot — replaced on consolidate
  open_threads: string[];                  // things to keep an eye on, agent's notes
  recent_decisions: { observed_at: string; text: string }[];  // last ~5
  
  participants: string[];                  // person_ids that appear across observations
  places: string[];                        // place_ids that appear across observations
  
  observation_count: number;               // total observations for this subject
  first_observed_at: string;
  last_observed_at: string;
  last_consolidated_at: string;
  
  sensitive: boolean;                      // OR of any contributing observation's sensitive flag
  status: 'active' | 'dormant' | 'closed';
  closed_reason?: string;
}
```

`status` semantics:
- `active` — recent observations exist; subject is live in the user's life
- `dormant` — no observations in N days (default 60); kept warm for retrieval but not surfaced in periodic checks
- `closed` — the thread is genuinely done (Tamar's pregnancy → baby is born; bookshelf built). Closed narratives are still recalled when relevant ("remember when…?").

The agent transitions status via `upsert_narrative`. No automatic close — too easy to misjudge.

## Tools

On the **personal-knowledge** MCP. Narratives are about identity-level threads in the user's world; they live with people/places/facts.

### note_observation

The primary write op. Called constantly and quietly during conversation processing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subjects | SubjectRef[] | yes | At least one. First is primary. |
| text | string | yes | The agent's phrasing of what was observed. |
| source | enum | yes | Provenance kind. |
| source_id | string | no | ID of the originating record. |
| source_excerpt | string | no | The actual line that triggered this. |
| confidence | enum | no | Default `medium`. Use `high` for explicit user statements, `low` for inference. |
| mood | string | no | Optional mood note. |
| sensitive | boolean | no | Default false. Set true for tender topics. |
| observed_at | string | no | Defaults to now. |

Returns the created `Observation`.

### recall

The primary read op. Agent calls this whenever an entity becomes salient in conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subjects | SubjectRef[] | yes (or `query`) | Pull observations tagged with any of these subjects. |
| query | string | no | Free-text search across observation text + narrative summary. Combinable with subjects. |
| since | string | no | ISO 8601 — only observations on/after this date. |
| limit | number | no | Default 30. |
| include_narrative | boolean | no | Default true. Returns the rolled-up narrative if one exists. |

Returns:
```json
{
  "narratives": [Narrative],          // any matching, with summary + open_threads + mood
  "observations": [Observation]       // chronological, most-recent-first by default
}
```

Recall is the moment the shadow notebook earns its keep. It must be fast, scoped, and return enough context for the agent to "remember" without re-reading everything.

### list_narratives

For skills and dashboards that want the rolled-up view across many subjects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| status | enum | no | active / dormant / closed. Default active. |
| subject_kind | enum | no | Filter by person / place / group / topic. |
| participant_id | string | no | Person involved. |
| stale_for_days | number | no | Active narratives with no new observation in N+ days. |
| query | string | no | Free-text search title + summary. |
| limit | number | no | Default 50. |

### get_narrative

Full retrieval for one subject — narrative + recent observations + open threads.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subject | SubjectRef | yes | The subject to load. |
| observation_limit | number | no | Default 30. Most recent first. |

### upsert_narrative

Explicit creation/update. Used when:
- The agent decides a topic-slug subject deserves a name and frame ("workload-management" → "Workload squeeze at Sunbit")
- The user explicitly names a thread ("Let's call this 'kitchen renovation'")
- Status transitions (active → dormant → closed)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subject | SubjectRef | yes | Identifies the narrative (one per subject). |
| title | string | no | Human-readable. Required on first create. |
| summary | string | no | Agent-rewritten. Use `consolidate_narrative` for the auto path. |
| current_mood | string | no | Snapshot. |
| open_threads | string[] | no | Replaces existing list. |
| status | enum | no | active / dormant / closed. |
| closed_reason | string | no | Required when status=closed. |
| sensitive | boolean | no | Bumps the flag (does not lower it — see Sensitivity). |

### consolidate_narrative

Agent rewrites the summary from accumulated observations. Same shape as `consolidate` for the user_model.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| subject | SubjectRef | yes | The subject to consolidate. |
| since | string | no | Only consolidate observations since this timestamp (incremental). |

The agent reads observations, drafts a new summary, identifies open threads, picks a current mood, and calls `upsert_narrative` internally. Returns the updated `Narrative`.

## Integration

### Journal still atomic

When the user says *"Rotem was quiet today,"* the agent writes a journal entry **and** a narrative observation tagged `{kind: 'person', ref: <rotem_id>}`. The observation carries `source: 'journal'`, `source_id: <journal_id>`. Journal remains the agent's atomic record; observations are the world-facing index over the same fact.

For implicit "overheard" signals (a WhatsApp message from a sister mentioning Tamar's baby), the observation is the only record — no journal entry needed unless the agent has its own thought to record.

### Conversation processing

When processing any inbound system message — WhatsApp, Telegram, phone IM, calendar event, location change — the agent should:
1. Identify subjects: who is mentioned? what group? what place? does this connect to a known topic?
2. If anything is worth remembering, call `note_observation` once with all relevant subjects.
3. If the message is in a known group with an active narrative, call `recall` for that group + any participant subjects to brief itself before responding.

This becomes a quiet habit, not a checklist phase.

### /catchup

Add a step:
- After loading journal + user_model, call `list_narratives({status: 'active', stale_for_days: 14})` to surface threads that haven't moved recently.
- Also `list_narratives({status: 'active'})` capped at e.g. 20 most-recently-touched, just to seed background awareness.
- Do not output to the user. Same silent absorption pattern.

### /daily

Optional and gentle: if a usually-active narrative has gone unusually quiet, *or* if a usually-quiet one has spiked, mention it once. *"Haven't heard about Itamar's class in a while — trip happened?"* Never list narratives mechanically. This is the rare push case.

### /review

Add a brief narratives phase **after** the GTD phases. Walk top 5 most-active narratives. For each: confirm summary is still right, prompt for any update the user wants to add, ask whether anything should close. Most weeks this is fast.

### Recall in agent prompt

Long-term: bake `recall` into the agent's default response loop so it fires on entity mention without explicit instruction. Short-term: the CLAUDE.md update should add it to the "Context before responding" checklist.

## Sensitivity

Some narratives are tender — self-esteem, marital, kids' moods, money worry. The `sensitive: true` flag lives on observations and propagates (logical OR) to the narrative.

**This system is single-user-private. The flag does not gate the agent.** It is informational:
- The agent can use sensitive narratives freely in its own reasoning.
- The agent should be more deliberate about *surfacing* them — avoid putting them in a daily summary that might glance off a phone screen, avoid bringing them up in front of family group context, avoid `push_to_user(level: notify+)` for sensitive content unless the user asked.
- Dashboard (when built) will show a subtle indicator and may default-hide on shared screens.

This is judgment, not enforcement. The character refresh and CLAUDE.md should describe the intended care.

## Storage

Elasticsearch on the **personal-knowledge** MCP.

Two indices:

```
ll5_knowledge_observations
ll5_knowledge_narratives
```

Both follow the same pattern as existing knowledge indices (canonical mappings live in `packages/shared/src/indices/`).

### ll5_knowledge_observations mapping

```
{
  user_id:        keyword,
  subjects: {
    type: 'nested',
    properties: {
      kind: keyword,
      ref:  keyword
    }
  },
  text:           text (multilingual analyzer for Hebrew),
  source:         keyword,
  source_id:      keyword,
  source_excerpt: text,
  confidence:     keyword,
  mood:           keyword,
  sensitive:      boolean,
  observed_at:    date,
  created_at:     date
}
```

Indices:
- `user_id` is the primary scope on every query
- `subjects.kind` + `subjects.ref` is the dominant filter (recall by subject)
- `observed_at` for chronological pulls
- `text` for free-text search (multilingual analyzer)

### ll5_knowledge_narratives mapping

```
{
  user_id:               keyword,
  subject: {
    properties: {
      kind: keyword,
      ref:  keyword
    }
  },
  title:                 text + keyword subfield,
  summary:               text (multilingual),
  current_mood:          keyword,
  open_threads:          text,
  recent_decisions: {
    type: 'nested',
    properties: { observed_at: date, text: text }
  },
  participants:          keyword,    // person_ids
  places:                keyword,    // place_ids
  observation_count:     integer,
  first_observed_at:     date,
  last_observed_at:      date,
  last_consolidated_at:  date,
  sensitive:             boolean,
  status:                keyword,
  closed_reason:         text
}
```

Uniqueness: one narrative per `(user_id, subject.kind, subject.ref)` enforced at the application layer (read-then-write in `upsert_narrative`). ES has no unique constraints; a deterministic doc id derived from the subject (e.g. `{user_id}:{kind}:{ref}`) is the cleanest enforcement.

## Multi-tenancy

Every query scoped by `user_id`. Same pattern as existing personal-knowledge indices. No new infra.

## Audit / logging

Both write tools (`note_observation`, `upsert_narrative`, `consolidate_narrative`) go through the existing `withToolLogging` + audit pipeline on personal-knowledge. Sensitive observations get a separate audit tag for later review of agent care.

## Phase plan

**Phase 1 — Substrate.** Indices, repositories, `note_observation`, `recall`, `list_narratives`, `get_narrative`. No agent prompt changes yet — confirm the data model holds up by manually noting observations.

**Phase 2 — Agent integration.** CLAUDE.md update: when to note vs journal, when to recall on entity mention, the soft sensitivity discipline. Update `/catchup` to load active narratives. Update conversation processing pattern.

**Phase 3 — Consolidation.** `consolidate_narrative` tool + a quiet background scheduler that consolidates narratives with N+ new observations since last consolidation. Tunable; off by default until shown to be worth it.

**Phase 4 — Surfaces.** `/review` phase, occasional `/daily` mention, eventual dashboard "Threads" page (read-only — narratives are agent-curated, not user-edited).

**Open for later:**
- Cross-narrative inference ("workload squeeze" + "Rotem's mood" might be related — let the agent connect these in summaries, not as a separate primitive)
- Narrative-to-narrative links (rarely needed; subject-overlap via participants/places already gives most of the value)
- Decay: should low-confidence inferred observations age out? Probably not — recall already weights by `observed_at` and `confidence`.
