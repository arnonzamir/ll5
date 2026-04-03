# Rename: "Notification Rules" to "Agent Routing Rules"

## Problem

LL5 has two separate systems that both use the word "notification":

1. **Routing rules** (currently "notification rules") — decides what the agent sees: ignore/batch/immediate/agent. Stored in `notification_rules` PG table.
2. **User notification levels** — decides how the phone grabs attention: silent/notify/alert/critical. Stored in `user_settings` JSONB.

This causes confusion in code, docs, and UI. The rename disambiguates them.

## Naming Convention

| Layer | Current | New |
|---|---|---|
| PG table | `notification_rules` | keep as-is (add `routing_rules` view) |
| Gateway class | `NotificationRuleMatcher` | `RoutingRuleMatcher` |
| Gateway file | `processors/notification-rules.ts` | `processors/routing-rules.ts` |
| Gateway endpoints | `/notification-rules` | `/routing-rules` |
| Dashboard route | `/settings/notifications` | `/settings/routing` |
| Dashboard files | `notification-settings-*` | `routing-settings-*` |
| Dashboard types | `NotificationRule` | `RoutingRule` |
| Dashboard page title | "Notification Rules" | "Message Routing" |
| Dashboard nav label | "Message Rules" | "Message Routing" |
| Test file | `__tests__/notification-rules.test.ts` | `__tests__/routing-rules.test.ts` |

## Migration Strategy

### Database: No table rename

Renaming PG tables is disruptive (constraints, indexes, migrations referencing old names). Instead:

1. **Keep** the `notification_rules` table name as the physical table.
2. **Add a view** `routing_rules` as an alias:
   ```sql
   CREATE OR REPLACE VIEW routing_rules AS SELECT * FROM notification_rules;
   ```
3. New code queries through the view. Existing queries continue to work.

### Gateway

1. Rename `processors/notification-rules.ts` -> `processors/routing-rules.ts`.
2. Rename class `NotificationRuleMatcher` -> `RoutingRuleMatcher`.
3. Add new endpoints `/routing-rules` (keep old as aliases for one deploy cycle).
4. Update imports and variable names.

### Dashboard

1. Create `settings/routing/` with renamed files and components.
2. Redirect old `/settings/notifications` -> `/settings/routing`.
3. Update nav label to "Message Routing".

### Documentation

Update FILE_TREE.md, HANDOFF.md, channel MCP instructions.

## Backward Compatibility

| Concern | Mitigation |
|---|---|
| Old gateway endpoint URLs | Keep `/notification-rules` as alias for one deploy cycle |
| Database table name | View alias; no breaking change |
| Dashboard bookmarks | Redirect to `/settings/routing` |

## Execution Order

1. Database migration (add `routing_rules` view)
2. Gateway: rename files + class + add new endpoints (keep old as aliases)
3. Dashboard: create new route, add redirect from old
4. Tests: rename and update
5. Docs: update all references
6. After one deploy cycle: remove old endpoint aliases
