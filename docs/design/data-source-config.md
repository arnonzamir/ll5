# Data Source Configuration

## Purpose

Let users enable/disable individual data sources. Currently all sources are implicitly active — GPS, IM capture, calendar, health, WhatsApp all run without user control.

## Settings Structure

Stored in the unified `user_settings` JSONB:

```json
{
  "timezone": "Asia/Jerusalem",
  "notification": { ... },
  "data_sources": {
    "gps": { "enabled": true },
    "im_capture": { "enabled": true },
    "calendar_sync": { "enabled": true },
    "health": { "enabled": true },
    "whatsapp": { "enabled": true }
  }
}
```

Default: all enabled (preserves current behavior for existing users).

## Enforcement Points

Each source checks its toggle before collecting data:

| Source | Where enforced | How |
|--------|---------------|-----|
| GPS | Android `LocationTrackingService` | Check settings on start, stop service if disabled |
| GPS | Gateway location webhook | Early return if `gps.enabled = false` |
| IM capture | Android `NotificationCaptureService` | Skip forwarding if disabled |
| IM capture | Gateway message processor | Early return if disabled |
| Calendar sync | Gateway `CalendarSyncScheduler` | Skip tick if disabled |
| Calendar sync | Android `CalendarChangeObserver` | Don't register observer if disabled |
| Health | Gateway `HealthPollScheduler` | Skip tick if disabled |
| Health | Health MCP `sync_health_data` | Check before syncing |
| WhatsApp | Gateway WhatsApp webhook | Early return if disabled |

### Gateway Enforcement

The gateway reads `user_settings.data_sources` on each webhook/scheduler tick. A shared helper:

```typescript
async function isSourceEnabled(pool: Pool, userId: string, source: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT settings->'data_sources'->$2->>'enabled' as enabled FROM user_settings WHERE user_id = $1",
    [userId, source],
  );
  // Default true if not configured
  return result.rows[0]?.enabled !== 'false';
}
```

### Android Enforcement

The Android app fetches settings from `GET /user-settings` on startup and caches them. When a source is toggled:
1. Dashboard saves to `PUT /user-settings`
2. Android fetches updated settings on next sync (or via FCM data message trigger)
3. Android starts/stops the relevant service

## Dashboard UI

New page: `/settings/data-sources`

Simple toggle list:

```
Data Sources
─────────────────────────────────────
GPS Location Tracking          [ON]
  Your location is tracked continuously

IM / Notification Capture      [ON]
  Phone notifications forwarded to the agent

Calendar Sync                  [ON]
  Google Calendar synced every 30 minutes

Health Monitoring              [ON]
  Health data synced from connected sources

WhatsApp Messages              [ON]
  WhatsApp messages processed via Evolution API
─────────────────────────────────────
```

Each toggle calls `PUT /user-settings` with the updated `data_sources` section.

## Disabling a Source

- **Stops new data collection** — no more GPS pings, no more IM forwarding, etc.
- **Preserves existing data** — nothing is deleted. Historical data remains queryable.
- **Reversible** — toggle back on and data collection resumes.

## Migration

No database migration needed — `user_settings` JSONB is schemaless. The absence of `data_sources` means "all enabled" (backward compatible).
