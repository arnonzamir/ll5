# DECISION-002 — Calendar event storage & non-destructive sync contract

Date: 2026-05-29
Status: Accepted
Scope: google MCP (`calendar-event.repository.ts`), gateway (`processors/calendar.ts`, `scheduler/calendar-sync.ts`)

## Context

Three coupled defects corrupted `ll5_awareness_calendar_events`, with live traces in production ES (admin user):

1. **Enrichment wrote the old title into `location`.** `processCalendar` merged a phone-pushed event onto a generic Google event with `location: item.location ?? existing.title`. Trace: **89 events** with `location == title` ("Sprint Planning" @ "Sprint Planning"), **348 events** with `location: "(no title)"`.
2. **The 30-min sync was destructive.** `calendar-sync` did a bulk `{ index }` (full doc replace) on id `google-<event_id>`, which reset `created_at` to "now" every run and reverted any enrichment (`source: merged`, merged title/location) back to raw Google.
3. **The doc id had no tenant component** (`google-<event_id>` / `tickler-<event_id>`), so two users sharing a Google event id would overwrite or cross-delete each other (see [DECISION-001](DECISION-001-tenant-scoped-by-id-access.md)).

## Decision

**Field-ownership split.** A calendar event doc has two field classes:

- **Identity / enrichment fields** — `created_at`, `title`, `location`, `source` — set **once, on insert** (the `upsert` branch). Never overwritten by a periodic re-sync.
- **Volatile scheduling fields** — start/end, attendees, calendar_name, all_day, description, updated_at — safe to overwrite on every sync (the partial `doc` branch).

Concretely:
- `calendar-sync` switched from `{ index }` to bulk `{ update }` with `{ doc, upsert }`: `doc` carries only volatile fields; the full document (with `created_at`, `source: 'google'`) lives only in `upsert`.
- Enrichment `location` falls back to `existing.location` (never `existing.title`); if neither push nor existing has a location, the field is omitted rather than fabricated.
- ES doc id is **user-namespaced**: `${userId}::google-${event_id}` (and `::tickler-`). `query()` filters on the `user_id` body term (not the id), so old-id docs keep reading during transition. `deleteForUser` deletes both the new scoped id and the legacy unscoped id (migration-safe).

## Alternatives considered

- **Keep `{ index }` but preserve `created_at` by reading first** — rejected: a read-before-write per event per sync, and still clobbers enrichment.
- **Scope deletes by `user_id` filter but keep the unscoped id** — rejected: a filter guards deletes but not *upsert overwrites*; only id-level namespacing prevents a wrong-user overwrite.
- **Recover the real location for the 437 corrupted docs** — not possible from ES alone; the repair script clears the bogus location to null and lets the next Google sync repopulate it correctly.

## Consequences

- Phone-push merges now survive periodic Google re-sync.
- One-time repair scripts authored (not auto-run): `gateway/scripts/repair-calendar-locations.ts` (clears `location==title` / generic-title locations) and `google/scripts/repair-calendar-event-ids.ts` (reindexes legacy ids to the scoped form). Both dry-run by default, `--apply` to execute, tenant-scoped.
- New invariant for future calendar writers: do not set identity/enrichment fields in a recurring sync's partial update.
