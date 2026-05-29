# DECISION-004 — GTD `completed_at` lifecycle semantics

Date: 2026-05-29
Status: Accepted
Scope: gtd MCP (`repositories/postgres/horizon.repository.ts` → `updateAction`)

## Context

`updateAction` used `else if (data.status)` to set `completed_at = NULL` for **any** status that wasn't `'completed'`. This wiped the historical completion timestamp whenever an action was parked (`on_hold`) or abandoned (`dropped`), and — worse — fired on any update that merely re-sent the current status alongside an unrelated field change.

## Decision

`completed_at` is mutated only on an explicit status transition:

- `status = 'completed'` → stamp `now()`.
- `status = 'active'` → clear to `NULL` (the sole transition that genuinely re-opens an action for work). Logged: `info clearing completed_at (re-opened to active) { id, userId }`.
- `status = 'on_hold' | 'dropped'` → leave `completed_at` untouched (preserve completion history).
- update with no `status` field → never touches `completed_at`.

This is a write-only implementation (no read-modify-write) — the branch keys purely on the incoming `status`.

## Alternatives considered

- **Clear `completed_at` on any non-completed status** (the old behavior) — rejected: destroys completion history for parked/abandoned items and on unrelated updates.
- **Read the current row, only clear if previously completed** — rejected: adds a read-modify-write for no behavioral gain; treating `active` as the only re-open transition achieves the same intent statelessly.

## Consequences

- An action's completion time survives being put `on_hold` or `dropped`.
- Note: `updateProject` / `upsertHorizon` still use the old `else if (data.status)` pattern (out of scope for this batch). Flagged as a follow-up if the same lifecycle should apply to projects/horizons.
