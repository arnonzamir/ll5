# LL5 Health MCP -- Implementation Plan

## 0. Configuration Model

Health monitoring is user-controlled at every level:

```
User Settings
  └── health.enabled: boolean (master switch)
       └── health.sources: { [sourceId]: SourceConfig }
            ├── garmin: { enabled, credentials, metrics: { sleep, heart_rate, ... } }
            ├── health_connect: { enabled, metrics: { ... } }  — future
            └── manual: { enabled, metrics: { ... } }  — future
```

**Per-user config** stored in `auth_users.settings` JSONB:
```json
{
  "health": {
    "enabled": true,
    "sources": {
      "garmin": {
        "enabled": true,
        "metrics": {
          "sleep": true,
          "heart_rate": true,
          "daily_stats": true,
          "activities": true,
          "stress": true,
          "body_composition": false
        }
      }
    }
  }
}
```

**Sync respects config** — only pulls enabled metrics from enabled sources.
**Tools respect config** — `get_sleep_summary` returns error if sleep tracking is off.
**Dashboard** — `/settings/health` page for toggling sources + metrics.

## 0.1 Generic Source Adapter Interface

Every health source implements the same interface. Adding Apple Health or Fitbit = implement these methods + a normalizer.

```typescript
interface HealthSourceAdapter {
  readonly sourceId: string;  // 'garmin', 'health_connect', 'fitbit'
  readonly displayName: string;

  // Connection
  connect(userId: string, credentials: Record<string, string>): Promise<void>;
  disconnect(userId: string): Promise<void>;
  getStatus(userId: string): Promise<{ connected: boolean; lastSync?: string }>;

  // Data fetching — each returns normalized generic types
  // Returns null if the source doesn't support this metric
  fetchSleep(userId: string, date: string): Promise<SleepData | null>;
  fetchHeartRate(userId: string, date: string): Promise<HeartRateData | null>;
  fetchDailyStats(userId: string, date: string): Promise<DailyStatsData | null>;
  fetchActivities(userId: string, from: string, to: string): Promise<ActivityData[]>;
  fetchBodyComposition(userId: string, date: string): Promise<BodyCompositionData | null>;
  fetchStress(userId: string, date: string): Promise<StressData | null>;
}
```

**Normalized types** (source-agnostic):
```typescript
interface SleepData {
  date: string;
  sleepTime: string;     // ISO
  wakeTime: string;      // ISO
  durationSeconds: number;
  deepSeconds: number;
  lightSeconds: number;
  remSeconds: number;
  awakeSeconds: number;
  qualityScore: number;  // 0-100
  averageHr?: number;
  lowestHr?: number;
}

interface HeartRateData {
  date: string;
  restingHr: number;
  minHr: number;
  maxHr: number;
  averageHr: number;
  zones: { rest: number; z1: number; z2: number; z3: number; z4: number; z5: number }; // seconds
  readings?: Array<{ timestamp: string; value: number }>;
}

interface DailyStatsData {
  date: string;
  steps: number;
  distanceMeters: number;
  floorsClimbed?: number;
  activeCalories: number;
  totalCalories: number;
  activeSeconds: number;
  energyLevel?: number;    // 0-100 (Garmin body battery, Whoop recovery, etc.)
  energyMin?: number;
  energyMax?: number;
}

interface StressData {
  date: string;
  average: number;
  max: number;
  readings?: Array<{ timestamp: string; value: number }>;
}

interface ActivityData {
  sourceId: string;
  activityType: string;    // normalized: running, cycling, swimming, etc.
  name: string;
  startTime: string;
  endTime: string;
  durationSeconds: number;
  distanceMeters?: number;
  calories?: number;
  averageHr?: number;
  maxHr?: number;
  elevationGain?: number;
}

interface BodyCompositionData {
  date: string;
  weightKg?: number;
  bodyFatPct?: number;
  muscleMassKg?: number;
  bmi?: number;
}
```

**The sync engine** iterates enabled sources × enabled metrics:
```typescript
async function syncUserHealth(userId: string, config: HealthConfig, date: string) {
  for (const [sourceId, sourceConfig] of Object.entries(config.sources)) {
    if (!sourceConfig.enabled) continue;
    const adapter = getAdapter(sourceId); // registry of HealthSourceAdapter instances

    if (sourceConfig.metrics.sleep) {
      const data = await adapter.fetchSleep(userId, date);
      if (data) await writeSleepToES(userId, sourceId, data);
    }
    if (sourceConfig.metrics.heart_rate) {
      const data = await adapter.fetchHeartRate(userId, date);
      if (data) await writeHeartRateToES(userId, sourceId, data);
    }
    // ... etc for each metric
  }
}
```

---

## 1. Storage

**Elasticsearch** (time-series health data) + **PostgreSQL** (source credentials/tokens).

ES provides native date range queries, aggregations for trends, and schema flexibility.
PG stores encrypted credentials per source per user.

---

## 2. Elasticsearch Index Schemas

Following the naming convention `ll5_{mcp}_{entity}`:

### Index: `ll5_health_sleep`

```json
{
  "mappings": {
    "properties": {
      "user_id":           { "type": "keyword" },
      "source":            { "type": "keyword" },
      "date":              { "type": "date", "format": "yyyy-MM-dd" },
      "sleep_time":        { "type": "date" },
      "wake_time":         { "type": "date" },
      "duration_seconds":  { "type": "integer" },
      "deep_seconds":      { "type": "integer" },
      "light_seconds":     { "type": "integer" },
      "rem_seconds":       { "type": "integer" },
      "awake_seconds":     { "type": "integer" },
      "quality_score":     { "type": "float" },
      "average_hr":        { "type": "float" },
      "lowest_hr":         { "type": "float" },
      "highest_hr":        { "type": "float" },
      "average_spo2":      { "type": "float" },
      "raw_data":          { "type": "object", "enabled": false },
      "synced_at":         { "type": "date" },
      "created_at":        { "type": "date" }
    }
  }
}
```

The `source` field is `"garmin"`, `"fitbit"`, `"apple_health"`, etc. The `raw_data` field stores the original API response for debugging/reprocessing. The `date` field is the calendar date the sleep is "for" (typically the wake date). Document IDs are deterministic: `{source}-sleep-{user_id}-{date}` for upsert/dedup.

### Index: `ll5_health_heart_rate`

```json
{
  "mappings": {
    "properties": {
      "user_id":           { "type": "keyword" },
      "source":            { "type": "keyword" },
      "date":              { "type": "date", "format": "yyyy-MM-dd" },
      "resting_hr":        { "type": "integer" },
      "min_hr":            { "type": "integer" },
      "max_hr":            { "type": "integer" },
      "average_hr":        { "type": "integer" },
      "zone_rest_seconds": { "type": "integer" },
      "zone_1_seconds":    { "type": "integer" },
      "zone_2_seconds":    { "type": "integer" },
      "zone_3_seconds":    { "type": "integer" },
      "zone_4_seconds":    { "type": "integer" },
      "zone_5_seconds":    { "type": "integer" },
      "readings":          { "type": "object", "enabled": false },
      "raw_data":          { "type": "object", "enabled": false },
      "synced_at":         { "type": "date" },
      "created_at":        { "type": "date" }
    }
  }
}
```

The `readings` field holds the continuous HR timeline (array of `{timestamp, value}`) but is stored un-indexed because it can contain thousands of points per day. When needed, the tool returns it from `_source`.

### Index: `ll5_health_daily_stats`

```json
{
  "mappings": {
    "properties": {
      "user_id":           { "type": "keyword" },
      "source":            { "type": "keyword" },
      "date":              { "type": "date", "format": "yyyy-MM-dd" },
      "steps":             { "type": "integer" },
      "distance_meters":   { "type": "float" },
      "floors_climbed":    { "type": "integer" },
      "active_calories":   { "type": "integer" },
      "total_calories":    { "type": "integer" },
      "active_seconds":    { "type": "integer" },
      "stress_average":    { "type": "float" },
      "stress_max":        { "type": "float" },
      "stress_readings":   { "type": "object", "enabled": false },
      "energy_level":      { "type": "float" },
      "energy_max":        { "type": "float" },
      "energy_min":        { "type": "float" },
      "spo2_average":      { "type": "float" },
      "respiration_average": { "type": "float" },
      "raw_data":          { "type": "object", "enabled": false },
      "synced_at":         { "type": "date" },
      "created_at":        { "type": "date" }
    }
  }
}
```

The `energy_level` field is the generic mapping of Garmin's "Body Battery" (0-100 scale). Other devices can map their own energy/readiness metrics to this same field (Whoop recovery score, Oura readiness). The `stress_average` is Garmin's stress score but normalized; other devices that report HRV-derived stress can map into the same field.

### Index: `ll5_health_activities`

```json
{
  "mappings": {
    "properties": {
      "user_id":           { "type": "keyword" },
      "source":            { "type": "keyword" },
      "source_id":         { "type": "keyword" },
      "activity_type":     { "type": "keyword" },
      "name":              { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "start_time":        { "type": "date" },
      "end_time":          { "type": "date" },
      "duration_seconds":  { "type": "integer" },
      "distance_meters":   { "type": "float" },
      "calories":          { "type": "integer" },
      "average_hr":        { "type": "integer" },
      "max_hr":            { "type": "integer" },
      "average_pace":      { "type": "float" },
      "elevation_gain":    { "type": "float" },
      "zone_1_seconds":    { "type": "integer" },
      "zone_2_seconds":    { "type": "integer" },
      "zone_3_seconds":    { "type": "integer" },
      "zone_4_seconds":    { "type": "integer" },
      "zone_5_seconds":    { "type": "integer" },
      "training_effect":   { "type": "float" },
      "raw_data":          { "type": "object", "enabled": false },
      "synced_at":         { "type": "date" },
      "created_at":        { "type": "date" }
    }
  }
}
```

The `activity_type` uses a normalized enum: `running`, `cycling`, `swimming`, `walking`, `strength`, `yoga`, `hiit`, `other`. Each source integration maps its own activity types to these normalized values. Document IDs: `{source}-activity-{source_id}`.

### Index: `ll5_health_body_composition`

```json
{
  "mappings": {
    "properties": {
      "user_id":           { "type": "keyword" },
      "source":            { "type": "keyword" },
      "date":              { "type": "date", "format": "yyyy-MM-dd" },
      "weight_kg":         { "type": "float" },
      "body_fat_pct":      { "type": "float" },
      "muscle_mass_kg":    { "type": "float" },
      "bmi":               { "type": "float" },
      "bone_mass_kg":      { "type": "float" },
      "body_water_pct":    { "type": "float" },
      "raw_data":          { "type": "object", "enabled": false },
      "synced_at":         { "type": "date" },
      "created_at":        { "type": "date" }
    }
  }
}
```

---

## 3. Authentication — `garmin-connect` npm package

**No Garmin Developer Program needed.** Uses the unofficial `garmin-connect` npm package which logs in with email/password (same as the Garmin Connect website), then caches OAuth1+OAuth2 tokens for subsequent requests.

### How it works:

```typescript
import { GarminConnect } from 'garmin-connect';
const client = new GarminConnect({ username: email, password: pass });
await client.login();

// Tokens auto-refresh. Persist them:
const oauth1 = client.oauth1Token;
const oauth2 = client.oauth2Token;

// Restore later without re-login:
client.loadToken(oauth1, oauth2);
```

### PG table for source credentials (generic, not Garmin-specific)

```sql
CREATE TABLE IF NOT EXISTS health_source_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     VARCHAR(255) NOT NULL,
  source_id   VARCHAR(50) NOT NULL,   -- 'garmin', 'fitbit', 'health_connect'
  credentials TEXT NOT NULL,           -- encrypted JSON (tokens, keys, etc.)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, source_id)
);
```

Each source stores whatever it needs in `credentials` (encrypted JSON):
- Garmin: `{ oauth1: {...}, oauth2: {...} }`
- Fitbit (future): `{ access_token, refresh_token, expires_at }`
- Health Connect (future): `{ last_sync_timestamp }` (no auth needed)

### MCP auth tools (generic):
- `connect_health_source` — connect a source (params: source_id, credentials). For Garmin: email + password → login → store tokens.
- `get_health_source_status` — check if a source is connected and working
- `disconnect_health_source` — remove stored credentials
- `list_health_sources` — list available sources with connection status

### Garmin-specific auth flow:
1. User calls `connect_health_source(source_id: "garmin", credentials: { email, password })`
2. Server calls `GarminConnect.login()`, gets OAuth tokens
3. Tokens encrypted and stored in `health_source_credentials`
4. Subsequent syncs load tokens — password NOT stored
5. If tokens expire, surface "Garmin disconnected" to user

---

## 5. MCP Tool Definitions

Following the exact registration pattern seen in the existing MCPs (using `server.tool()` with zod schemas):

### `get_sleep_summary`

```
Description: "Get sleep data for a specific date or last night. Returns duration, stages, quality score, heart rate during sleep."
Parameters:
  date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to last night.")
```

Returns: sleep/wake times, duration, stage breakdown (deep/light/REM/awake as both seconds and percentages), quality score, average/lowest HR during sleep.

### `get_heart_rate`

```
Description: "Get heart rate data for a date or date range. Returns resting HR, zones, min/max, and optionally continuous readings."
Parameters:
  date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today.")
  from: z.string().optional().describe("Start date for range query (YYYY-MM-DD).")
  to: z.string().optional().describe("End date for range query (YYYY-MM-DD).")
  include_readings: z.boolean().optional().describe("Include continuous HR readings timeline. Default: false.")
```

### `get_daily_stats`

```
Description: "Get daily health stats: steps, calories, stress, body battery/energy, distance, floors for a date."
Parameters:
  date: z.string().optional().describe("Date in YYYY-MM-DD format. Defaults to today.")
```

### `get_activities`

```
Description: "Get recent workouts/activities. Returns type, duration, calories, heart rate, distance."
Parameters:
  from: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to 7 days ago.")
  to: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today.")
  activity_type: z.string().optional().describe("Filter by type: running, cycling, swimming, walking, strength, yoga, hiit, other.")
  limit: z.number().min(1).max(50).optional().describe("Max results. Default: 10.")
```

### `get_body_composition`

```
Description: "Get latest weight and body composition data, or history over a date range."
Parameters:
  date: z.string().optional().describe("Specific date. Defaults to latest available.")
  from: z.string().optional().describe("Start date for history.")
  to: z.string().optional().describe("End date for history.")
```

### `get_health_trends`

```
Description: "Get weekly or monthly trends for any health metric. Returns averages, min/max, and trend direction."
Parameters:
  metric: z.enum(["sleep_duration", "sleep_quality", "resting_hr", "steps", "stress", "energy", "weight", "active_calories"]).describe("Which metric to trend.")
  period: z.enum(["week", "month", "quarter"]).optional().describe("Trend period. Default: week.")
  compare: z.boolean().optional().describe("Compare to previous period. Default: true.")
```

This tool uses ES aggregations (`date_histogram` + `avg`/`min`/`max`) to compute trends directly in ES, avoiding pulling all raw data.

### `sync_health_data`

```
Description: "Manually trigger a sync of health data from Garmin Connect. Pulls data for the specified date range."
Parameters:
  from: z.string().optional().describe("Start date (YYYY-MM-DD). Defaults to yesterday.")
  to: z.string().optional().describe("End date (YYYY-MM-DD). Defaults to today.")
  categories: z.array(z.enum(["sleep", "heart_rate", "daily_stats", "activities", "body_composition"])).optional().describe("Which categories to sync. Defaults to all.")
```

### Auth tools (3 tools, following the Google MCP pattern)

- `get_garmin_auth_url`
- `get_garmin_connection_status`
- `disconnect_garmin`

**Total: 10 tools** (7 data + 3 auth)

---

## 6. Garmin API Client

### Module: `packages/health/src/clients/garmin.ts`

Uses the `garmin-connect` npm package which wraps Garmin Connect's internal API.

**Available methods:**

| Method | Returns |
|--------|---------|
| `getSteps(date)` | Daily step count |
| `getSleepData(date)` | Sleep session with stages |
| `getHeartRate(date)` | HR summary + continuous readings |
| `getActivities(start, limit)` | Activity list |
| `getActivity(id)` | Activity detail |
| `getUserProfile()` | User info |

**Note:** The package may not expose all Garmin data (stress, body battery, body composition) via named methods. For those, use the `get()` method with direct API paths — the library handles auth signing:

```typescript
const dailySummary = await client.get('/wellness-api/rest/dailies', { date });
const bodyComp = await client.get('/wellness-api/rest/bodyComps', { date });
const stress = await client.get('/wellness-api/rest/stressDetails', { date });
```

### Data normalization

A `GarminNormalizer` module maps Garmin-specific fields to the generic schema:

```typescript
// Garmin "bodyBatteryChargedValue" → generic "energy_level"
// Garmin "averageStressLevel" → generic "stress_average"
// Garmin "deepSleepSeconds" → generic "deep_seconds"
// Garmin activity type codes → generic activity types
```

Each future integration (Fitbit, Apple Health) would have its own normalizer with the same output types.

---

## 7. Sync Strategy

### Three-tier sync approach:

**Tier 1: Periodic pull (gateway scheduler)**
- A new `HealthSyncScheduler` in the gateway runs every 30 minutes during active hours (matching the calendar sync pattern).
- Calls the health MCP's internal sync endpoint (or directly calls the Garmin client and writes to ES, following the `CalendarSyncScheduler` pattern).
- Pulls daily summaries for today and yesterday (yesterday catches late-arriving sleep data).
- Uses deterministic document IDs for upsert (no duplicates).

**Tier 2: On-demand pull (via `sync_health_data` tool)**
- Agent or user explicitly requests a sync.
- Can specify date range and categories.
- Used for backfill ("sync my last 30 days") or when the agent notices stale data.

**Tier 3: Push notifications (Phase 2)**
- Register a webhook URL with Garmin: `POST /garmin/webhook` on the gateway.
- Garmin pushes notification when new data is available (sleep processed, activity uploaded).
- Gateway receives the notification, fetches the new data, writes to ES, optionally sends a system message ("New sleep data: 7.2h, quality 82").
- This is the same pattern as the WhatsApp webhook in `packages/gateway/src/processors/whatsapp-webhook.ts`.

### Sync state tracking

No separate sync state table needed. The `synced_at` field on each ES document records when it was last synced. To check if data is fresh, the scheduler queries ES for the latest `synced_at` per category and compares to now. If the data is older than the sync interval, it re-fetches.

---

## 8. Gateway Scheduler Integration

### New file: `packages/gateway/src/scheduler/health-sync.ts`

Following the exact pattern of `CalendarSyncScheduler`:

```typescript
export class HealthSyncScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private es: Client,
    private healthClient: GarminHealthClient,
    private userId: string,
    private intervalMs: number = 30 * 60 * 1000,
  ) {}

  start(): void { /* run immediately, then setInterval */ }
  stop(): void { /* clearInterval */ }
  
  async sync(): Promise<void> {
    // Fetch today + yesterday from Garmin
    // Bulk index into ES with deterministic doc IDs
    // Log success/failure (non-blocking)
  }
}
```

### Wiring into `packages/gateway/src/scheduler/index.ts`

Add a new optional dependency block (like the Google-dependent schedulers):

```typescript
// --- Health-dependent schedulers (only start if health MCP is configured) ---
const healthClient = createGarminHealthClient(config.healthMcpUrl, config.healthMcpApiKey);
if (healthClient) {
  const healthSync = new HealthSyncScheduler(es, healthClient, userId);
  healthSync.start();
}
```

**Important design choice:** The gateway scheduler calls the health MCP's REST API (similar to how it calls the Google MCP's `/api/events`), rather than directly calling the Garmin API. This keeps the Garmin auth logic encapsulated within the health MCP. The health MCP exposes a `GET /api/sync` REST endpoint that the gateway calls.

### Gateway env additions

Two new env vars in `packages/gateway/src/utils/env.ts`:

```typescript
healthMcpUrl: process.env.HEALTH_MCP_URL,        // e.g., http://health:3000
healthMcpApiKey: process.env.HEALTH_MCP_API_KEY,  // ll5 signed token
```

### Morning briefing enhancement

Modify `DailyReviewScheduler` in `packages/gateway/src/scheduler/daily-review.ts` to also fetch health data from the health MCP (if configured) and include it in the morning briefing:

```
[Morning Briefing] Good morning! Today is Monday, March 31.
Sleep: 7h 12m (deep: 1h 30m, REM: 1h 45m). Quality: 82/100.
Energy: Body battery at 78. Resting HR: 58.
...calendar events...
```

---

## 9. File Structure

```
packages/health/
  package.json                          # @ll5/health, type: module
  tsconfig.json                         # Same as awareness/google
  src/
    index.ts                            # Entry point (export + startServer)
    server.ts                           # Express app, MCP endpoint, OAuth callback
    
    utils/
      env.ts                            # EnvConfig + loadEnv()
      logger.ts                         # Logger (copy from awareness)
      encryption.ts                     # Symlink or re-export from google utils
    
    clients/
      adapter.ts                         # HealthSourceAdapter interface
      registry.ts                       # Adapter registry: sourceId → adapter instance
      garmin/
        garmin-adapter.ts               # GarminAdapter implements HealthSourceAdapter
        garmin-client.ts                # garmin-connect npm wrapper
        garmin-normalizer.ts            # Garmin API → generic types
    
    repositories/
      interfaces/
        index.ts
        health-data.repository.ts       # SleepRepository, HeartRateRepository, etc.
        oauth-token.repository.ts       # HealthOAuthTokenRepository interface
      elasticsearch/
        index.ts
        base.repository.ts              # Copy from awareness (or import from @ll5/shared)
        sleep.repository.ts
        heart-rate.repository.ts
        daily-stats.repository.ts
        activity.repository.ts
        body-composition.repository.ts
      postgres/
        base.repository.ts              # Copy from google
        oauth-token.repository.ts       # Garmin OAuth tokens (encrypted)
    
    setup/
      indices.ts                        # ensureIndices for all 5 health ES indices
    
    tools/
      index.ts                          # registerAllTools
      sources.ts                        # connect/disconnect/status/list health sources
      sleep.ts                          # get_sleep_summary
      heart-rate.ts                     # get_heart_rate
      daily-stats.ts                    # get_daily_stats
      activities.ts                     # get_activities
      body-composition.ts               # get_body_composition
      trends.ts                         # get_health_trends
      sync.ts                           # sync_health_data
    
    types/
      index.ts
      sleep.ts                          # Generic Sleep type
      heart-rate.ts                     # Generic HeartRate type
      daily-stats.ts                    # Generic DailyStats type
      activity.ts                       # Generic Activity type
      body-composition.ts               # Generic BodyComposition type
    
    migrations/
      001_create_tables.sql             # health_oauth_tokens table
    
    auth-middleware.ts                   # Token auth (copy from awareness)
```

---

## 10. Docker/Deployment

### Dockerfile

Uses the existing `docker/Dockerfile.mcp` with `PACKAGE_NAME=health`. No new Dockerfile needed -- the shared MCP Dockerfile handles it.

### docker-compose.prod.yml addition

```yaml
health:
  image: ghcr.io/arnonzamir/ll5-health:${IMAGE_TAG:-latest}
  container_name: ll5-health
  environment:
    NODE_ENV: production
    PORT: "3000"
    LOG_LEVEL: ${LOG_LEVEL:-info}
    AUTH_SECRET: ${AUTH_SECRET}
    API_KEY: ${API_KEY}
    USER_ID: ${USER_ID}
    ELASTICSEARCH_URL: http://elasticsearch:9200
    DATABASE_URL: postgresql://${POSTGRES_USER:-ll5}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-ll5}
    # No Garmin API keys needed — uses garmin-connect npm (email/password auth)
    ENCRYPTION_KEY: ${ENCRYPTION_KEY}
  networks:
    - ll5-net
  depends_on:
    elasticsearch:
      condition: service_healthy
    postgres:
      condition: service_healthy
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.ll5-health.rule=Host(`mcp-health.${DOMAIN}`)"
    - "traefik.http.routers.ll5-health.tls=true"
    - "traefik.http.routers.ll5-health.tls.certresolver=letsencrypt"
    - "traefik.http.services.ll5-health.loadbalancer.server.port=3000"
  restart: unless-stopped
```

### CI/CD

Add `"health"` to the `PACKAGES` array in `.github/workflows/build-and-push.yml` line 29.

### Client config (ll5-run)

Add to `.claude/settings.json` permissions: `"mcp__health__*"`.

Register the MCP in the ll5-run `.mcp.json` (or wherever MCP connections are configured):

```json
{
  "health": {
    "url": "https://mcp-health.noninoni.click/mcp",
    "headers": { "Authorization": "Bearer ${LL5_TOKEN}" }
  }
}
```

---

## 11. Generic Data Model for Future Integrations

The data model is already device-agnostic by design. To add a new source (e.g., Fitbit):

1. Create a new client file: `packages/health/src/clients/fitbit.ts`
2. Create a normalizer: `packages/health/src/clients/fitbit-normalizer.ts` that maps Fitbit API responses to the same generic types
3. Add OAuth 2.0 auth tools for Fitbit (the PG `health_oauth_tokens` table already supports multi-provider via the `provider` column)
4. The ES indices, repositories, MCP data tools, and trend analysis all remain unchanged

The `source` field on every document identifies where data came from. If both Garmin and Fitbit report sleep for the same date, both records exist. The repository methods can:
- Return data from a specific source: `{ term: { source: "garmin" } }`
- Return the "best" data by preferring the most detailed source
- Merge complementary data across sources (future enhancement)

---

## 12. Proactive Agent Use

### Morning briefing changes

The `DailyReviewScheduler` in the gateway already sends a morning system message. The enhancement adds a health summary section by calling `GET /api/summary` on the health MCP (a new REST endpoint, similar to `/api/events` on the Google MCP). The briefing message would include:

```
Sleep: 7h 12m (quality 82, deep 1h30m). HR: resting 58.
Energy: 78/100. Steps yesterday: 8,432.
```

### Recovery assessment

The agent already has all the tools it needs for "Am I recovered enough for a run?". The CLAUDE.md in ll5-run would be updated with guidance:

```
### health MCP
- `get_sleep_summary` — last night or specific date
- `get_heart_rate` — resting HR, zones, continuous data
- `get_daily_stats` — steps, calories, stress, body battery/energy
- `get_activities` — recent workouts
- `get_body_composition` — weight, body fat
- `get_health_trends` — weekly/monthly trend for any metric
- `sync_health_data` — manual sync from Garmin

Recovery assessment: when asked "should I run/train/exercise", check:
1. Energy level (body battery / energy_level in daily_stats)
2. Last night's sleep quality
3. Resting HR trend (elevated = overtrained)
4. Recent activity load (last 3-7 days of activities)
5. Current stress level
Combine these signals into practical advice. No medical claims.
```

### Pattern detection

The `get_health_trends` tool with `compare: true` surfaces trend direction. The agent can proactively check during weekly reviews or morning briefings:

- 3+ consecutive nights with sleep quality below 60 -> "Sleep has been rough this week. Consider lighter schedule."
- Resting HR trending up over the week -> "Your resting heart rate is elevated. You might be overtrained or getting sick."
- Steps consistently below 5,000 -> "Activity has been low this week."

These can be driven by a new gateway scheduler (`HealthInsightsScheduler`) or simply by agent intelligence using the trend tool.

---

## 13. Implementation Sequence

### Phase 1: Foundation (core MCP, no Garmin yet)

1. Create `packages/health/` directory structure
2. Set up `package.json`, `tsconfig.json`
3. Create ES index definitions in `setup/indices.ts`
4. Create PG migration for `health_oauth_tokens`
5. Create domain types in `types/`
6. Create repository interfaces and ES implementations
7. Create `server.ts` with Express + MCP endpoint
8. Create `env.ts`, `logger.ts`, `auth-middleware.ts`
9. Create `tools/index.ts` with tool registrations
10. Implement all 7 data tools (read from ES)
11. Implement `sync_health_data` tool (write to ES from mock data for testing)
12. Test locally against docker-compose ES

### Phase 2: Garmin integration

1. Install `garmin-connect` npm package
2. Implement `clients/garmin.ts` using garmin-connect library
3. Implement `clients/normalizer.ts` for Garmin -> generic mapping
4. Implement PG `oauth-token.repository.ts` with encryption
5. Implement 3 auth tools (`get_garmin_auth_url`, `get_garmin_connection_status`, `disconnect_garmin`)
6. Wire `sync_health_data` to actually call Garmin API
7. Add OAuth callback route in `server.ts`
8. Add REST API endpoints (`GET /api/summary`, `GET /api/sync`)

### Phase 3: Gateway integration + deployment

1. Add `HealthSyncScheduler` to gateway
2. Enhance `DailyReviewScheduler` with health summary
3. Add health MCP to `docker-compose.prod.yml`
4. Add to CI/CD pipeline
5. Deploy to Coolify
6. Connect Garmin account via OAuth flow
7. Backfill historical data (30-90 days)

### Phase 4: Advanced features

1. Garmin push webhook support (gateway endpoint)
2. `HealthInsightsScheduler` for proactive pattern detection
3. Dashboard health page (daily stats, sleep chart, activity log)
4. Cross-domain correlations (stress vs calendar load -- uses existing awareness calendar data)

---

## 14. What Goes in the Roadmap Doc

Add to `docs/PROGRESS.md` under a new section:

```
### Planned: Health MCP
| Service | Status | Notes |
|---------|--------|-------|
| health MCP | Design complete | Garmin Connect integration, ES storage |

Design: docs/design/mcp-health.md
```

Create `docs/design/mcp-health.md` with the full design doc (ES schemas, tool definitions, Garmin OAuth flow, sync strategy, data model).

Update `docs/FILE_TREE.md` with the `packages/health/` tree.

Update `docs/HANDOFF.md`:
- Add health MCP to the architecture diagram
- Add Garmin OAuth section (consumer key, consumer secret, redirect URI, scopes)
- Add `ll5_health_*` indices to the Elasticsearch section
- Add `health_oauth_tokens` table to the PostgreSQL section

---

## 15. Key Risks and Mitigations

**Unofficial API stability**: The `garmin-connect` npm package uses reverse-engineered Garmin Connect APIs. Garmin could change their internal API at any time. Mitigation: The package is actively maintained and widely used. If it breaks, the generic health data model means we can swap to Health Connect (Android) or another source without changing tools or indices.

**Login persistence**: Garmin may invalidate sessions periodically or require MFA. Mitigation: Store tokens in PG, auto-retry login, surface "Garmin disconnected" to user via system message if tokens fail.

**Rate limits**: Garmin's rate limits are not well-documented. Mitigation: The sync scheduler runs every 30 minutes (24 API calls/day per category), which is conservative. Add exponential backoff on 429 responses. Log rate limit headers for monitoring.

**Data freshness for sleep**: Garmin processes sleep data with a delay (sometimes hours after waking). The morning briefing at 7am might not have last night's sleep yet. Mitigation: The briefing should gracefully handle missing data ("Sleep data not yet available"). The 30-minute sync will pick it up once Garmin processes it. Garmin push notifications (Phase 2) solve this properly.

**Encryption key sharing**: The health MCP needs the same `ENCRYPTION_KEY` as the Google MCP for token encryption. This is fine -- the key is already a Coolify environment variable shared across services. The encryption utility is the same AES-256-GCM implementation.

---

### Critical Files for Implementation

- `/Users/arnon/workspace/ll5/packages/awareness/src/setup/indices.ts` -- Reference for ES index creation pattern, directly replicable for health indices
- `/Users/arnon/workspace/ll5/packages/google/src/tools/auth.ts` -- Reference for connection management pattern (status check, disconnect)
- `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/index.ts` -- Where the new HealthSyncScheduler must be wired in, shows the dependency pattern for optional service schedulers
- `/Users/arnon/workspace/ll5/packages/awareness/src/repositories/elasticsearch/base.repository.ts` -- Base ES repository class to copy/reuse for all health repositories
- `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/daily-review.ts` -- Morning briefing scheduler that needs health data enhancement
