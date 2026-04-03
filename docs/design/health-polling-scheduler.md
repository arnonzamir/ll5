# Health Polling Scheduler

## Purpose

The agent currently has no awareness of health events as they happen. This scheduler polls ES for newly synced health data every 15-20 minutes, detects notable changes, and pushes system messages so the agent can react contextually.

The scheduler does **not** perform syncing — it assumes the Health MCP's `sync_health_data` has already written data to ES (triggered by agent or a future sync scheduler). Its sole job is detection and notification.

## Architecture

Runs in the gateway as a scheduler, alongside calendar sync, GTD health, etc.

```
Gateway Scheduler (every 20 min, during active hours)
  ├── Query ES for new data (synced_at > last check)
  ├── Compare with last-known state
  ├── If notable → insertSystemMessage() with notification level
  └── Update last-seen timestamps (in-memory)
```

### State: In-Memory Only

```typescript
interface HealthPollingState {
  lastSeen: {
    sleep: string | null;      // last synced_at processed
    heartRate: string | null;
    dailyStats: string | null;
    activities: string | null;
    bodyComposition: string | null;
  };
  reportedToday: Set<string>;  // dedup: "sleep:2026-04-03", "activity:12345"
  currentDate: string | null;
}
```

- On restart: initialize `lastSeen` from max `synced_at` per index (no re-firing old events)
- `reportedToday` resets on date rollover
- No PG table needed — this is essentially a cache

## Event Detection

Each tick queries ES for documents where `synced_at > lastSeen[metric]`.

### What's Notable

| Event | Always Notify | Conditional | Never |
|-------|--------------|-------------|-------|
| Sleep ended | Yes (daily) | | |
| Activity completed | If >10 min | | <10 min |
| Weight logged | Yes (rare) | | |
| Unusual resting HR | | If >15% above 7-day avg | Normal range |
| High stress | | If avg >70 for day | Normal |
| Low energy | | If battery <20 | Normal |
| Steps milestone | | If >12k at evening | Intra-day |

### Baseline Comparisons

For conditional events (unusual HR, high stress), query a 7-day rolling average from ES. Skip conditional notifications if fewer than 3 baseline data points exist (prevents false alerts during first week).

### Notification Levels

| Event | Level | Rationale |
|-------|-------|-----------|
| Sleep ended (normal) | `silent` | Informational |
| Sleep ended (<5h or quality <40) | `notify` | Agent should check in |
| Activity completed | `silent` | Routine |
| Weight logged | `silent` | Routine |
| Unusual resting HR | `alert` | Could indicate illness |
| High stress day | `notify` | Agent adjusts approach |
| Low energy | `notify` | Agent adjusts expectations |

## System Message Format

```
[Health] You woke up at 07:15 after 6.8 hours of sleep (quality: 72). Deep: 1.2h, REM: 1.5h.
```

```
[Health] Running completed — 42 min, 5.3 km, avg HR 148.
```

```
[Health Alert] Resting HR today is 78 bpm — 22% above your 7-day average of 64.
```

### Batching

If multiple events in one tick (sleep + daily stats + activity all synced at once), combine into one message:

```
[Health] Morning update:
- Slept 6.8h (quality: 72)
- Yesterday: 9,847 steps, 2,340 cal, body battery 65
```

## Configuration

```typescript
interface HealthPollConfig {
  intervalMinutes: number;  // Default: 20
  startHour: number;        // Reuse calendarReviewStartHour
  endHour: number;          // Reuse calendarReviewEndHour
  timezone: string;         // From user_settings
  userId: string;
}
```

Env: `HEALTH_POLLING_INTERVAL_MINUTES` (default: 20)

### Tunable Constants (in-code)

| Constant | Value | Description |
|----------|-------|-------------|
| `MIN_ACTIVITY_DURATION_SEC` | 600 | Activities <10min not reported |
| `HR_ANOMALY_PCT` | 15 | Resting HR >15% above avg triggers alert |
| `SLEEP_SHORT_HOURS` | 5 | Sleep below this → notify |
| `SLEEP_QUALITY_LOW` | 40 | Quality below this → notify |
| `STRESS_HIGH` | 70 | Daily avg above this → notify |
| `ENERGY_LOW` | 20 | Body battery below this → notify |
| `BASELINE_MIN_POINTS` | 3 | Min data points for comparisons |

## Long-Term: Android Health Connect

This scheduler is the near-term solution. Long-term: Android app listens to Health Connect API for real-time events from any fitness app (Garmin, Samsung, Fitbit) and pushes to gateway webhook. That replaces polling with push but requires Android integration.
