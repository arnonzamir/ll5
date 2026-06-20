# DECISION-013: Governed agent memory — intercept native Claude Code memory into Elasticsearch

## Context

The live agent (`ll5-run`) used Claude Code's **native auto-memory**: markdown files under
`~/.claude/projects/-workspace-ll5-run/memory/`, recalled by the harness as `<system-reminder>`
blocks. On 2026-06-20 this caused a concrete failure: the agent held **two contradictory memories**
about whether `create_tickler` interprets `due_time` as local or UTC (one written before a code fix,
one after), never reconciled them, and **hedged by double-booking "UTC-variant" ticklers**.

Root cause is structural — the native store is:
- **append-only** — new lessons sit beside old; nothing reconciles contradictions on write;
- **never invalidated** — a workaround memory stays "true" after its bug is fixed (the agent even ran
  the memory's own falsification test, saw it pass, and kept the stale belief);
- **ungoverned & invisible** — box-only runtime files, not in git, no audit, no dashboard.

Meanwhile the agent's other memory (user_model, journal, knowledge graph) is well governed
(versioned, audited, cross-sourced). Goal: bring memory under that same governance.

## Decision

**Intercept Claude Code's native memory via hooks and reroute it to a governed ES-backed store.**
The agent keeps its natural "save this" behavior; storage is validated, contradictions are resolved at
write time, recall is deliberate, and the belief store becomes queryable, versioned, and visible.

Mechanism (validated by a Phase-0 spike on Claude Code 2.1.178):
- **Write** — a `PreToolUse` hook (`memory-intercept.sh`, matcher `Write|Edit`, path filter `*/memory/*`)
  sends the content to the awareness MCP and **denies the disk write**. Keeping the memory dir empty
  makes native recall inert without depending on an undocumented disable flag.
- **Read** — native recall is replaced by governed injection: `SessionStart` injects the durable
  runbook; `UserPromptSubmit` (`memory-recall.sh`) injects per-turn matches via `recall_lessons`.

Store + governance live in the **awareness MCP** (beside `user_model`/journal — the agent's own state):
- New global index `ll5_agent_lessons` (+ `_history`), copying the user_model versioning + `logAudit`
  pattern. **Scope split** (the operative distinction): **world** lessons = operating/system knowledge,
  global and shared (a runbook, invalidated by deploys, recalled by task); **user** lessons = about the
  specific user, routed into the existing `user_model` (no parallel store).
- Tools: `upsert_lesson` (reconcile-on-write — a contradicting write is blocked until resolved via
  `supersede_id`/`force`), `recall_lessons`, `list_lessons`, `retire_lesson`, and `ingest_memory` (the
  automatic hook entry: classifies world/user, auto-merges a very strong world match in place, else
  inserts; appends user knowledge to `user_model.learned_notes`).
- `durable` vs `provisional` class: provisional lessons (bug workarounds) carry a `falsification_test`
  and `depends_on`, surface flagged *verify-before-trust*, and should be retired when their bug is fixed.
- Dashboard: a `/lessons` page renders the runbook (durable + provisional) for visibility.

## Alternatives considered

- **New explicit `save_lesson` MCP tool + CLAUDE.md instruction** (no interception). Rejected as the
  primary path: relies on the agent remembering to call it; the interception captures natural behavior.
  Kept as the documented fallback if the hook contract regresses.
- **Govern the native store in place** (reconcile-on-write as prose). Rejected: prose guidance is
  advisory and is exactly what failed; an MCP tool can *enforce*.
- **A user-scoped lessons store** for user knowledge. Rejected: duplicates the user_model, which already
  governs user understanding with versioning + audit.

## Consequences

- Contradictions can no longer silently coexist; the create_tickler-timezone trap is structurally
  prevented (reconcile-on-write + auto-merge-in-place).
- The belief store is now versioned (`*_history`), audited (`ll5_audit_log`), and visible (`/lessons`).
- World lessons are global — one tenant's operational gotcha helps all, and they double as a runbook.
- New dependency on the hook contract (`PreToolUse` deny + `SessionStart`/`UserPromptSubmit` injection),
  pinned by a spike; a Claude Code change to those semantics would require revisiting (fallback above).
- Classification (world vs user) is heuristic at ingest; mis-files are reviewable on the dashboard and
  fixable via `upsert_lesson`/`retire_lesson`.
- Existing on-disk `feedback_*.md` are migrated into the store; the memory dir is then cleared.
