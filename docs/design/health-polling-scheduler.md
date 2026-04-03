# Health Polling Scheduler

## Purpose

Periodically poll the Health MCP for new data and notify the agent when something notable happens — sleep ended, activity completed, unusual heart rate, weight change. Bridges the gap between on-demand sync and real-time awareness.

## Architecture

Runs in the gateway as a scheduler (same pattern as CalendarSyncScheduler, GTDHealthScheduler, etc.).

```
Gateway Scheduler (every 15 min)
  ├── Call Health MCP: sync_health_data (pulls from Garmin etc.)
  ├── Call Health MCP: get_sleep_summary, get_daily_stats, get_activities
  ├── Compare with last-known state
  ├── If notable change → insertSystemMessage() to agent
  └── Update last-known state in PG
```

## State Tracking

New table in gateway PG:

```sql
CREATE TABLE IF NOT EXISTS health_poll_state (
  user_id     UUID NOT NULL,
  metric      VARCHAR(50) NOT NULL,  -- 'sleep', 'activity', 'daily_stats', 'weight'
  last_value  JSONB NOT NULL DEFAULT '{}',
  checked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, metric)
);
```

`last_value` stores the last-seen state per metric:
- sleep: `{ date, wake_time, duration_seconds }`
- activity: `{ last_activity_id }`
- daily_stats: `{ date, steps, stress_average }`
- weight: `{ date, weight_kg }`

## Event Detection

### Sleep Events
- **Sleep ended**: New sleep record appeared for today (wasn't there last check)
- Notify: `[Health] You slept 7.2h last night (quality: 82). Deep: 1.5h, REM: 1.8h`
- Level: `silent`

### Activity Events
- **Activity completed**: New activity ID not in last_value
- Notify: `[Health] Running completed — 5.2km in 32min, avg HR 145`
- Level: `silent` (unless it's a notable achievement)

### Daily Stats
- **Unusual stress**: stress_average > 50 (high) when last check was normal
- Notify: `[Health] Stress level elevated today (avg: 58). Consider a break.`
- Level: `notify` (actionable context)

### Weight
- **Weight logged**: New weight record different from last
- Notify: `[Health] Weight: 78.2kg (down 0.3kg from last reading)`
- Level: `silent`

## What NOT to Notify

- Steps increasing throughout the day (normal)
- Heart rate within normal range
- Same data as last poll (no change)
- Data older than 24 hours (backfill, not real-time)

## Configuration

```typescript
interface HealthPollConfig {
  intervalMinutes: number;  // Default: 15
  startHour: number;        // Default: 6
  endHour: number;          // Default: 23
  timezone: string;         // From user_settings
  userId: string;
}
```

Environment variables:
- `HEALTH_POLL_INTERVAL_MINUTES` (default: 15)
- Health MCP URL already configured as `MCP_HEALTH_URL`

## Implementation

```typescript
class HealthPollScheduler {
  // On each tick:
  // 1. Trigger sync: call sync_health_data on Health MCP
  // 2. Fetch latest data for each metric
  // 3. Compare with health_poll_state
  // 4. If changed and notable: insertSystemMessage()
  // 5. Update health_poll_state
}
```

The scheduler calls the Health MCP tools via HTTP (same as how gateway calls Google MCP for calendar sync). It uses the same `callMcpTool` pattern.

## Long-Term: Android Health Connect

This scheduler is the near-term solution. The long-term approach is the Android app listening to Health Connect API for real-time events and pushing them to the gateway webhook (same pattern as GPS and calendar push). That would replace polling with push — but requires Health Connect integration on Android.
