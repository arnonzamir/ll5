# Data Source Configuration

## Purpose

Per-source toggles that let users enable/disable each data collection pipeline. Currently all sources are implicitly active with no user control.

## Settings Structure

In the unified `user_settings` JSONB, alongside `timezone` and `notification`:

```json
{
  "data_sources": {
    "gps": { "enabled": true, "interval_seconds": 300 },
    "im_capture": { "enabled": true },
    "calendar": { "enabled": true },
    "health": { "enabled": true },
    "whatsapp": { "enabled": true }
  }
}
```

Default: all enabled (preserves current behavior). Absence of `data_sources` = all enabled.

## Enforcement Points

### Gateway Helper

```typescript
// packages/gateway/src/utils/data-source-config.ts
async function isSourceEnabled(pool: Pool, userId: string, source: string): Promise<boolean>;
```

Reads from `user_settings`, caches with 60s TTL. Returns `true` if not configured (backward-compatible).

### Per-Source Enforcement

| Source | File | How |
|--------|------|-----|
| GPS | `processors/location.ts` | Early return in `processLocation` |
| IM capture | `processors/message.ts` | Early return in `processMessage` |
| Calendar (phone) | `processors/calendar.ts` | Early return in `processCalendar` |
| Calendar (Google) | `scheduler/calendar-sync.ts` | Skip in sync cycle |
| Health | Health MCP sync tool | Check before fetching |
| WhatsApp | `processors/whatsapp-webhook.ts` | Early return (200 OK to Evolution API) |
| Android (all) | `SettingsRepository.kt` | Local toggles + device command sync |

### Android Sync

When user toggles a source in the dashboard:
1. `PUT /user-settings` updates JSONB
2. Gateway queues a device command: `{ command_type: "update_data_source", payload: { source: "gps", enabled: false } }`
3. Android `DeviceCommandHandler` processes it, updates local DataStore
4. Relevant service (LocationTrackingService, NotificationCaptureService, etc.) starts/stops

## Dashboard UI

New page: `/settings/data-sources`

One card per source with toggle switch, source-specific config (collapsed when disabled), and "last data" timestamp.

```
GPS Location Tracking              [ON]
  Last point: 2 minutes ago

IM Notification Capture            [ON]
  Last capture: 5 minutes ago

Calendar Events                    [ON]
  Last sync: 12 minutes ago

Health Data                        [ON]
  Last sync: 3 hours ago

WhatsApp Messages                  [ON]
  Last message: 1 minute ago
```

## Existing Data

Disabling a source **stops new collection only**. Existing data is preserved and queryable. Re-enabling resumes collection. No data is deleted.

## Migration

No database migration needed — `user_settings` JSONB is schemaless. Implementation order:

1. Gateway helper (`isSourceEnabled`) — no behavior change since defaults are all enabled
2. Add enforcement checks to each processor — no-op deploy
3. Dashboard UI — user can now toggle
4. Android device command handling — keeps phone and server in sync
