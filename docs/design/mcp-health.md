# LL5 Health MCP -- Implementation Plan

## 1. Architecture Decision: Storage

**Decision: Elasticsearch (primary) + PostgreSQL (OAuth tokens only)**

Health data is fundamentally time-series data. All the main data categories (sleep, heart rate, steps, stress, activities, body composition) are timestamped records that get queried by date ranges. This maps directly to the pattern used by the awareness MCP. ES provides:
- Native date range queries for "last night's sleep", "this week's trend"
- Aggregation support for computing averages, min/max, percentiles over periods
- Schema flexibility for adding new device sources without migrations
- Consistent pattern with `ll5_awareness_*` indices

PG is needed only for OAuth 1.0a tokens (Garmin consumer key/secret and user's access token/secret), following the exact same pattern as `google_oauth_tokens`.

**ES indices for health data, PG table for Garmin OAuth tokens.**

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

## 3. PostgreSQL Tables (OAuth 1.0a Tokens)

### Migration: `001_create_tables.sql`

```sql
CREATE TABLE IF NOT EXISTS health_oauth_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         VARCHAR(255) NOT NULL,
  provider        VARCHAR(50) NOT NULL,
  access_token    TEXT NOT NULL,
  token_secret    TEXT NOT NULL,
  consumer_key    TEXT,
  scopes          TEXT[] DEFAULT '{}',
  user_access_id  TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_health_oauth_tokens_user_provider
  ON health_oauth_tokens(user_id, provider);
```

This table stores OAuth 1.0a tokens (Garmin) as well as OAuth 2.0 tokens (future Fitbit). The `provider` field distinguishes them. The `token_secret` field is the OAuth 1.0a token secret (encrypted with AES-256-GCM, reusing the encryption utility from `packages/google`). For OAuth 2.0 providers, `token_secret` stores the refresh token. The `consumer_key` is stored per-user to support multiple Garmin developer accounts if needed, though typically it comes from env vars.

---

## 4. Garmin OAuth 1.0a Flow

Garmin uses OAuth 1.0a, which is a three-legged flow:

1. **Request Token**: Server calls `https://connectapi.garmin.com/oauth-service/oauth/request_token` with consumer key/secret. Gets a temporary request token + secret.
2. **Authorization**: User is redirected to `https://connect.garmin.com/oauthConfirm?oauth_token=<request_token>`. User logs into Garmin and approves.
3. **Access Token**: After approval, Garmin redirects to our callback URL with `oauth_token` and `oauth_verifier`. Server exchanges these for a permanent access token + secret.

### Implementation approach

Use the `oauth-1.0a` npm package (lightweight, well-maintained) combined with Node's native `fetch` for HTTP calls. Do NOT use a full Garmin SDK -- none exists officially; the API is plain REST.

**Server endpoints in `packages/health/src/server.ts`:**

- `GET /oauth/garmin/callback` -- public endpoint, no auth. Garmin redirects here after user approves. Exchanges verifier for access token and stores it encrypted in PG.

**MCP tools for the flow:**

- `get_garmin_auth_url` -- Generates the Garmin authorization URL. Internally calls Garmin's request_token endpoint, stores the temporary token in memory (same pattern as `pendingStates` Map in the Google MCP), returns the URL for the user to visit.
- `get_garmin_connection_status` -- Checks if Garmin tokens exist and tests them against the Garmin API.
- `disconnect_garmin` -- Deletes stored tokens.

**Key differences from Google OAuth 2.0:**

- OAuth 1.0a has no token refresh. Access tokens are permanent until revoked.
- Every API request must be signed with HMAC-SHA1 using the consumer secret + token secret.
- The `oauth-1.0a` library handles request signing.

### In-memory state for OAuth flow

Same pattern as `/Users/arnon/workspace/ll5/packages/google/src/tools/auth.ts` lines 15-16:

```typescript
export const pendingOAuthRequests = new Map<string, {
  requestToken: string;
  requestTokenSecret: string;
  userId: string;
}>();
```

Cleaned up after 10 minutes with `setTimeout`, identical to the Google MCP.

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

This is the core integration layer. It encapsulates:

1. OAuth 1.0a request signing (using `oauth-1.0a` + `crypto`)
2. API endpoint calls with rate-limit awareness
3. Response parsing into generic health data types

**Garmin Connect API endpoints (documented at developer.garmin.com):**

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/wellness-api/rest/dailies` | GET | Steps, calories, distance, floors, stress, body battery |
| `/wellness-api/rest/epochs` | GET | 15-minute activity summaries |
| `/wellness-api/rest/sleeps` | GET | Sleep sessions with stages |
| `/wellness-api/rest/heartRates` | GET | Daily HR summary + zones |
| `/wellness-api/rest/bodyComps` | GET | Weight, body fat, BMI |
| `/wellness-api/rest/activities` | GET | Logged activities/workouts |
| `/wellness-api/rest/stressDetails` | GET | Granular stress readings |

**Note on Garmin's push API:** Garmin supports webhooks where they push new data to your server when it becomes available. This is the preferred approach for production but requires a registered callback URL. The health MCP should support both pull (for initial sync and manual refresh) and push (for real-time updates). Push support is Phase 2.

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
      garmin.ts                         # Garmin API client (OAuth 1.0a signing, endpoints)
      normalizer.ts                     # GarminNormalizer: Garmin → generic types
      types.ts                          # Garmin raw API response types
    
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
      auth.ts                           # get_garmin_auth_url, status, disconnect
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
    GARMIN_CONSUMER_KEY: ${GARMIN_CONSUMER_KEY}
    GARMIN_CONSUMER_SECRET: ${GARMIN_CONSUMER_SECRET}
    GARMIN_REDIRECT_URI: https://mcp-health.noninoni.click/oauth/garmin/callback
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

1. Register at developer.garmin.com for API access
2. Implement `clients/garmin.ts` with OAuth 1.0a signing
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

**Garmin Developer Program access**: Registration at developer.garmin.com requires approval. Lead time is unclear (could be days to weeks). Mitigation: Phase 1 builds the entire MCP without Garmin, using mock data. The Garmin client is a swappable integration.

**OAuth 1.0a complexity**: OAuth 1.0a request signing is more complex than OAuth 2.0. Every API request requires HMAC-SHA1 signature computation. Mitigation: Use the `oauth-1.0a` npm package which handles all signing logic. It's well-tested and lightweight.

**Rate limits**: Garmin's rate limits are not well-documented. Mitigation: The sync scheduler runs every 30 minutes (24 API calls/day per category), which is conservative. Add exponential backoff on 429 responses. Log rate limit headers for monitoring.

**Data freshness for sleep**: Garmin processes sleep data with a delay (sometimes hours after waking). The morning briefing at 7am might not have last night's sleep yet. Mitigation: The briefing should gracefully handle missing data ("Sleep data not yet available"). The 30-minute sync will pick it up once Garmin processes it. Garmin push notifications (Phase 2) solve this properly.

**Encryption key sharing**: The health MCP needs the same `ENCRYPTION_KEY` as the Google MCP for token encryption. This is fine -- the key is already a Coolify environment variable shared across services. The encryption utility is the same AES-256-GCM implementation.

---

### Critical Files for Implementation

- `/Users/arnon/workspace/ll5/packages/awareness/src/setup/indices.ts` -- Reference for ES index creation pattern, directly replicable for health indices
- `/Users/arnon/workspace/ll5/packages/google/src/tools/auth.ts` -- Reference for OAuth flow pattern (pending states, auth URL generation, callback handling, connection status), adaptable for OAuth 1.0a
- `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/index.ts` -- Where the new HealthSyncScheduler must be wired in, shows the dependency pattern for optional service schedulers
- `/Users/arnon/workspace/ll5/packages/awareness/src/repositories/elasticsearch/base.repository.ts` -- Base ES repository class to copy/reuse for all health repositories
- `/Users/arnon/workspace/ll5/packages/gateway/src/scheduler/daily-review.ts` -- Morning briefing scheduler that needs health data enhancement
