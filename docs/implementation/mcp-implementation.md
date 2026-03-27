# MCP Implementation Plans

Step-by-step guides for building each MCP server, from shared foundation through individual components.

---

## Shared Foundation

### Project Structure

Monorepo using `packages/` directory. Each MCP is an independent package with its own `package.json`, `tsconfig.json`, and `Dockerfile`.

```
ll5/
  packages/
    shared/
      types/              # Domain types shared across MCPs
      storage/            # Repository interface base types (PaginatedResult, PaginationParams)
      auth/               # Auth middleware (API key validation, user_id extraction)
      mcp-utils/          # MCP server boilerplate, health endpoint, error formatting
    mcp-personal-knowledge/
    mcp-gtd/
    mcp-awareness/
    mcp-google/
    mcp-messaging/
  docker/
    Dockerfile.mcp        # Shared multi-stage Dockerfile (build arg selects package)
```

Use npm workspaces (or pnpm workspaces) for dependency management. Each package references shared packages via workspace protocol (`"@ll5/types": "workspace:*"`).

### Shared Packages

#### `@ll5/types`

Common TypeScript types used across multiple packages:

```typescript
// Pagination
interface PaginationParams { limit?: number; offset?: number; }
interface PaginatedResult<T> { items: T[]; total: number; }

// Search
interface SearchResult<T> { entity_id: string; score: number; highlight: string; data: T; }

// Auth
interface UserContext { userId: string; }

// Error types
class NotFoundError extends Error { constructor(entity: string, id: string) }
class ValidationError extends Error { constructor(field: string, message: string) }
class AuthenticationError extends Error {}
```

#### `@ll5/storage`

Base classes and utilities for storage implementations:

- `ElasticsearchBase` -- wraps `@elastic/elasticsearch` Client, provides `withUserFilter(userId, query)` helper that injects `term: { user_id }` filter into every query
- `PostgresBase` -- wraps `pg` Pool, provides `withUserId(userId)` helper that prepends `WHERE user_id = $1` and optionally sets `app.current_user_id` session variable for RLS
- Connection factory functions that read from environment variables
- Index/table creation utilities

#### `@ll5/auth`

Auth middleware for MCP servers:

- V1: Read `Authorization: Bearer <api_key>` header, compare against `API_KEY` env var, resolve to `USER_ID` env var
- Returns `UserContext` with `userId` on success, throws `AuthenticationError` on failure
- Designed to swap to JWT validation (V2) without changing MCP code

#### `@ll5/mcp-utils`

MCP server boilerplate:

- `createMcpServer(config)` -- factory that creates an MCP `Server` instance with HTTP+SSE transport using `@modelcontextprotocol/sdk`
- Tool registration helper that wraps handlers with auth extraction, input validation, and error formatting
- Health endpoint (`GET /health`) that checks storage connectivity
- Graceful shutdown handler (close DB connections, drain HTTP server)
- Structured logging (JSON to stdout)

### TypeScript Configuration

Base `tsconfig.json` at repo root with strict settings. Each package extends it:

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src"
  }
}
```

Build with ESBuild for fast compilation. Each MCP produces a single bundled `dist/index.js` for the Docker image.

### MCP Server Boilerplate

Every MCP follows this pattern:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const server = new McpServer({ name: "ll5-personal-knowledge", version: "1.0.0" });

// Register tools
server.tool("tool_name", "description", { /* zod schema */ }, async (params, extra) => {
  const userId = extractUserId(extra);  // from auth middleware
  // ... handler logic
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
});

// Start HTTP+SSE transport
const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
// Mount on Express/Fastify with auth middleware
```

### Auth Middleware Pattern

```typescript
// Runs before MCP protocol handling
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const key = authHeader.slice(7);
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  req.userId = process.env.USER_ID;
  next();
}
```

The `userId` is then accessible in tool handlers via the request context, not as a tool parameter. Tools never accept `userId` from the caller.

### Docker

Shared multi-stage Dockerfile, parameterized by build arg:

```dockerfile
FROM node:20-alpine AS builder
ARG PACKAGE_NAME
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/ packages/shared/
COPY packages/${PACKAGE_NAME}/ packages/${PACKAGE_NAME}/
RUN npm ci --workspace=packages/${PACKAGE_NAME}
RUN npm run build --workspace=packages/${PACKAGE_NAME}

FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=builder /app/packages/${PACKAGE_NAME}/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Build per MCP:
```bash
docker build --build-arg PACKAGE_NAME=mcp-personal-knowledge -t ghcr.io/arnon/ll5-mcp-personal-knowledge .
```

### Environment Variables Pattern

Every MCP reads:

```env
# Server
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# Auth (V1)
API_KEY=<hex-encoded-256-bit-key>
USER_ID=<uuid>

# Storage (varies by MCP)
ELASTICSEARCH_URL=http://elasticsearch:9200
ELASTICSEARCH_API_KEY=<key>
# or
DATABASE_URL=postgresql://user:pass@postgres:5432/ll5

# MCP-specific
# (documented per MCP below)
```

---

## MCP 1: personal-knowledge

**Storage:** Elasticsearch
**Tools:** 13 (profile: 2, search: 1, facts: 4, people: 4, places: 4, data gaps: 2) -- but some are CRUD so the pattern repeats
**Complexity:** Medium -- straightforward CRUD + search, but ES query building requires care

### Phase 1: Repository Layer

**Steps:**

1. **Define domain types** in `src/types.ts`:
   - `Profile` (user_id, name, timezone, location, bio, birth_date, languages)
   - `Fact` (id, user_id, type, category, content, provenance, confidence, tags, source, valid_from, valid_until, timestamps)
   - `Person` (id, user_id, name, aliases, relationship, contact_info, tags, notes, timestamps)
   - `Place` (id, user_id, name, type, address, geo, tags, notes, timestamps)
   - `DataGap` (id, user_id, question, priority, status, context, answer, timestamps)
   - Enum types: `FactType`, `Provenance`, `PlaceType`, `DataGapStatus`
   - Filter types: `FactFilters`, `PersonFilters`, `PlaceFilters`, `DataGapFilters`
   - Input types: `UpsertFactInput`, `UpsertPersonInput`, `UpsertPlaceInput`, `UpsertDataGapInput`

2. **Define repository interfaces** in `src/repositories/interfaces.ts`:
   - `ProfileRepository` -- get, upsert
   - `FactRepository` -- list, get, upsert, delete, search
   - `PersonRepository` -- list, get, upsert, delete, search
   - `PlaceRepository` -- list, get, upsert, delete, search, searchNear
   - `DataGapRepository` -- list, upsert
   - All methods take `userId` as first parameter
   - All list methods accept `PaginationParams`, return `PaginatedResult<T>`

3. **Implement ES index management** in `src/repositories/elasticsearch/indices.ts`:
   - Index creation function for each of the 5 indices (`ll5_knowledge_profile`, `ll5_knowledge_facts`, `ll5_knowledge_people`, `ll5_knowledge_places`, `ll5_knowledge_data_gaps`)
   - Custom multilingual analyzer (ICU tokenizer, lowercase, asciifolding for Hebrew+English)
   - Mapping definitions matching the design doc
   - `ensureIndices()` function that creates indices if they don't exist (idempotent, runs on server startup)
   - No migration framework needed -- ES mappings are additive (new fields added without breaking old data)

4. **Implement `ElasticsearchProfileRepository`**:
   - `get(userId)` -- fetch document with `_id = userId` from `ll5_knowledge_profile`
   - `upsert(userId, data)` -- use ES `index` API with `_id = userId`, merge with existing fields

5. **Implement `ElasticsearchFactRepository`**:
   - `list(userId, filters)` -- build `bool` query with `filter` for user_id, type, category, provenance, tags (terms), minConfidence (range); optional `must` for query (multi_match with fuzziness); pagination via `from`/`size`; sort by `updated_at` desc
   - `get(userId, id)` -- get by `_id`, verify `user_id` matches
   - `upsert(userId, data)` -- if `data.id` provided, update existing doc (verify user_id first); otherwise create new doc with generated UUID; for new facts, run deduplication check: search for similar content using `more_like_this` query, return existing match if score is very high
   - `delete(userId, id)` -- delete by `_id`, verify `user_id` matches (use delete-by-query with user_id filter for safety)
   - `search(userId, query)` -- `multi_match` on content field with `fuzziness: "AUTO"`, `bool.filter` on user_id, return `SearchResult<Fact>[]` with highlights

6. **Implement `ElasticsearchPersonRepository`**:
   - Same CRUD pattern as facts but over `ll5_knowledge_people`
   - `search` uses `multi_match` across name, aliases, notes fields
   - Name matching needs special care: fuzzy on both Hebrew and English variants

7. **Implement `ElasticsearchPlaceRepository`**:
   - Same CRUD pattern over `ll5_knowledge_places`
   - `searchNear(userId, lat, lon, radiusKm)` -- use `geo_distance` filter on the `geo` field
   - `list` with `near` filter also uses `geo_distance` and sorts by `_geo_distance`

8. **Implement `ElasticsearchDataGapRepository`**:
   - `list(userId, filters)` -- filter by status, minPriority (range query), sorted by priority desc
   - `upsert(userId, data)` -- create or update, similar pattern to facts

9. **Write helper utilities**:
   - `buildUserFilter(userId)` -- returns `{ term: { user_id: userId } }` clause
   - `mapHits<T>(response)` -- extracts `_source` from ES hits, maps `_id` to `id` field, returns typed array
   - `buildPagination(params)` -- converts `limit`/`offset` to ES `size`/`from`

10. **Write in-memory implementations** for testing:
    - `InMemoryFactRepository`, `InMemoryPersonRepository`, etc.
    - Store data in `Map<string, T[]>` keyed by userId
    - Simple filter matching (exact match on keywords, substring on text)
    - Used in unit tests to test tool handlers without ES dependency

**Estimated effort:** Medium

### Phase 2: MCP Tools

**Steps:**

1. **Create tool registration module** `src/tools/index.ts`:
   - Import all repositories
   - Register each tool with the MCP server using `server.tool()`
   - Each tool handler: extract userId from auth context, validate input with zod, call repository, format response

2. **Implement profile tools**:
   - `get_profile` -- call `profileRepo.get(userId)`, return profile or empty profile scaffold
   - `update_profile` -- validate fields (timezone must be valid IANA, birth_date must be valid date), call `profileRepo.upsert(userId, data)`

3. **Implement `search_knowledge` tool**:
   - Run parallel searches across facts, people, places repositories using their `search()` methods
   - Merge results, normalize scores to 0-1 range
   - Filter by `entity_types` if specified, apply `min_score` threshold
   - Sort merged results by score descending, apply `limit`
   - Build unified `summary` line per entity type (fact: content truncated, person: name + relationship, place: name + type)

4. **Implement fact tools** (list_facts, get_fact, upsert_fact, delete_fact):
   - Direct mapping from tool parameters to repository method calls
   - `upsert_fact`: validate required fields (type, category, content, provenance, confidence), validate confidence is 0-1, validate provenance enum
   - Return `{ fact, created }` for upsert, `{ deleted: true }` for delete

5. **Implement people tools** (list_people, get_person, upsert_person, delete_person):
   - `upsert_person`: name is required on create (when no id), validate contact_info structure
   - Handle aliases as array of strings

6. **Implement place tools** (list_places, get_place, upsert_place, delete_place):
   - `list_places` with `near` parameter: validate lat/lon ranges, pass to repository's geo search
   - `upsert_place`: validate geo coordinates if provided (lat -90 to 90, lon -180 to 180)
   - Validate place type enum

7. **Implement data gap tools** (list_data_gaps, upsert_data_gap):
   - `list_data_gaps`: default status filter to `"open"` if not provided
   - `upsert_data_gap`: validate priority is 1-10 integer

8. **Error handling**:
   - `NotFoundError` from repository -> return MCP error response with `isError: true`
   - `ValidationError` -> return MCP error with descriptive message
   - Unexpected errors -> log full error, return generic "Internal error" to client

9. **Write tool tests**:
   - Use in-memory repositories
   - Test each tool with valid input, missing required fields, invalid values, not-found IDs
   - Test `search_knowledge` cross-entity merging
   - Test upsert create vs. update behavior

**Estimated effort:** Medium

### Phase 3: Server Setup

**Steps:**

1. **Create `src/index.ts` entry point**:
   - Initialize Elasticsearch client from env vars
   - Run `ensureIndices()` to create indices if missing
   - Create repository instances, injecting ES client
   - Create MCP server, register all tools
   - Mount auth middleware
   - Start HTTP server on `PORT`
   - Register graceful shutdown (close ES client, stop HTTP server)

2. **Add health endpoint** (`GET /health`):
   - Ping Elasticsearch cluster
   - Return `{ status: "healthy", elasticsearch: "connected" }` or `503` if ES is down

3. **Dockerize**:
   - Use shared Dockerfile with `PACKAGE_NAME=mcp-personal-knowledge`
   - Environment variables: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`, `API_KEY`, `USER_ID`, `PORT`
   - Test: build image, run with docker-compose alongside ES container, hit health endpoint

4. **Smoke test the full stack**:
   - Start ES + MCP container
   - Create a profile, upsert a fact, search for it
   - Verify user_id isolation (if using a second user, queries return nothing)

**Estimated effort:** Small

---

## MCP 2: gtd

**Storage:** PostgreSQL
**Tools:** 14 (actions: 3, projects: 3, horizons: 2, inbox: 3, shopping: 1, recommendations: 1, health: 1)
**Complexity:** Large -- most tools, complex recommendation logic, relational joins

### Phase 1: Repository Layer

**Steps:**

1. **Define domain types** in `src/types.ts`:
   - `Action` (horizon=0 fields: id, user_id, horizon, title, description, status, energy, context, list_type, due_date, start_date, project_id, waiting_for, time_estimate, category, completed_at, timestamps)
   - `ActionWithProject` extends Action with `project_title: string | null`
   - `Project` (horizon=1 fields: id, user_id, horizon, title, description, status, category, area_id, due_date, completed_at, timestamps)
   - `ProjectWithCounts` extends Project with `active_action_count: number`, `has_no_actions: boolean`
   - `HorizonItem` (generic for h=2-5: id, user_id, horizon, title, description, status, timestamps)
   - `HorizonItemWithCounts` extends HorizonItem with `active_project_count: number` (only for h=2)
   - `InboxItem` (id, user_id, content, source, source_link, status, outcome_type, outcome_id, notes, processed_at, timestamps)
   - `ReviewSession` (id, user_id, review_type, started_at, completed_at, notes, health_snapshot, timestamps)
   - `GtdHealth` (inbox_count, projects_without_actions, overdue_count, stale_waiting_count, days_since_last_review, active_project_count, active_action_count, someday_count, completed_this_week)
   - `RecommendResult` (quick, medium, deep arrays of scored actions)
   - Enum types: `Energy`, `ListType`, `ActionStatus`, `ProjectStatus`, `ReviewType`, `OutcomeType`
   - Filter types: `ActionFilters`, `ProjectFilters`, `HorizonFilters`, `InboxFilters`
   - Input types: `CreateActionInput`, `UpdateActionInput`, `CreateProjectInput`, `UpdateProjectInput`, `UpsertHorizonInput`, `CaptureInboxInput`, `ProcessInboxInput`

2. **Define repository interfaces** in `src/repositories/interfaces.ts`:
   - `HorizonRepository` -- createAction, updateAction, findActionByTitle, listActions, createProject, updateProject, listProjects, upsertHorizon, listHorizons, getHealth, recommendActions
   - `InboxRepository` -- capture, list, process
   - `ReviewSessionRepository` -- create, getLatest, complete

3. **Write SQL migrations** in `src/migrations/`:
   - `001_create_gtd_horizons.sql` -- CREATE TABLE with all columns, CHECK constraints, indexes (from design doc)
   - `002_create_gtd_inbox.sql` -- CREATE TABLE with status CHECK, outcome_type CHECK, indexes
   - `003_create_gtd_review_sessions.sql` -- CREATE TABLE with review_type CHECK, indexes
   - Migration runner: simple sequential runner that tracks applied migrations in a `_migrations` table, runs on startup

4. **Implement `PostgresHorizonRepository`**:
   - `createAction(userId, data)` -- INSERT into gtd_horizons with `horizon=0`, validate project_id exists if provided (SELECT before INSERT), set defaults (status=active, list_type=todo, energy=medium)
   - `updateAction(userId, id, data)` -- UPDATE with SET for each provided field; if `status='completed'` set `completed_at=NOW()`; if `status='active'` clear `completed_at`; return updated row
   - `findActionByTitle(userId, titleSearch)` -- `SELECT ... WHERE user_id=$1 AND horizon=0 AND title ILIKE '%' || $2 || '%'`; if 0 results return null, if >1 results throw ValidationError("Multiple actions match, please be more specific")
   - `listActions(userId, filters)`:
     - Base query: `SELECT h.*, p.title as project_title FROM gtd_horizons h LEFT JOIN gtd_horizons p ON h.project_id = p.id WHERE h.user_id=$1 AND h.horizon=0`
     - Append conditions dynamically: status, list_type, energy, category, project_id, due_before (`due_date <= $N`), due_after (`due_date >= $N`), overdue (`due_date < CURRENT_DATE AND status='active'`)
     - Context filter: `h.context && $N::text[]` (PostgreSQL array overlap operator)
     - Query filter: `(h.title ILIKE '%' || $N || '%' OR h.description ILIKE '%' || $N || '%')`
     - Count query for total
     - ORDER BY: due_date ASC NULLS LAST, created_at DESC
     - LIMIT/OFFSET from pagination params
   - `createProject(userId, data)` -- INSERT with `horizon=1`, validate area_id if provided
   - `updateProject(userId, id, data)` -- UPDATE, handle status transitions, set completed_at on completion
   - `listProjects(userId, filters)`:
     - Use subquery or LEFT JOIN to count active actions: `SELECT p.*, COUNT(a.id) FILTER (WHERE a.status='active') as active_action_count FROM gtd_horizons p LEFT JOIN gtd_horizons a ON a.project_id=p.id AND a.horizon=0 WHERE p.user_id=$1 AND p.horizon=1 GROUP BY p.id`
     - Compute `has_no_actions = active_action_count == 0 AND status == 'active'`
   - `upsertHorizon(userId, data)` -- if data.id, UPDATE; else INSERT with horizon=data.horizon (validate 2-5)
   - `listHorizons(userId, filters)` -- similar to listProjects but for h=2-5; for h=2, include active project count via subquery
   - `getHealth(userId)` -- single query with multiple aggregations:
     ```sql
     SELECT
       (SELECT COUNT(*) FROM gtd_inbox WHERE user_id=$1 AND status='captured') as inbox_count,
       (SELECT COUNT(*) FROM gtd_horizons WHERE user_id=$1 AND horizon=1 AND status='active'
         AND id NOT IN (SELECT DISTINCT project_id FROM gtd_horizons WHERE user_id=$1 AND horizon=0 AND status='active' AND project_id IS NOT NULL)
       ) as projects_without_actions,
       (SELECT COUNT(*) FROM gtd_horizons WHERE user_id=$1 AND horizon=0 AND status='active' AND due_date < CURRENT_DATE) as overdue_count,
       (SELECT COUNT(*) FROM gtd_horizons WHERE user_id=$1 AND horizon=0 AND list_type='waiting' AND status='active' AND updated_at < NOW() - INTERVAL '7 days') as stale_waiting_count,
       ...
     ```
   - `recommendActions(userId, criteria)` -- query active todo actions, apply filters, score and group (detailed in Phase 2)

5. **Implement `PostgresInboxRepository`**:
   - `capture(userId, data)` -- INSERT into gtd_inbox, status='captured'
   - `list(userId, filters)` -- SELECT with status filter, ORDER BY created_at DESC
   - `process(userId, id, data)` -- UPDATE status='processed', set outcome_type, outcome_id, notes, processed_at=NOW()

6. **Implement `PostgresReviewSessionRepository`**:
   - `create(userId, data)` -- INSERT into gtd_review_sessions
   - `getLatest(userId, reviewType?)` -- SELECT ... ORDER BY started_at DESC LIMIT 1, optional WHERE review_type=$2
   - `complete(userId, id, notes?)` -- UPDATE completed_at=NOW(), save health snapshot (call getHealth and store result)

7. **Write in-memory implementations** for testing:
   - `InMemoryHorizonRepository` -- store arrays, implement filter logic in JS
   - `InMemoryInboxRepository`, `InMemoryReviewSessionRepository`

**Estimated effort:** Large

### Phase 2: MCP Tools

**Steps:**

1. **Implement action tools** (create_action, update_action, list_actions):
   - `create_action`: validate energy enum, list_type enum, context is string array, due_date/start_date are valid ISO dates, project_id references existing project (repo validates); call `repo.createAction()`
   - `update_action`: accept either `id` or `title_search` (exactly one required); if `title_search`, call `repo.findActionByTitle()` first to resolve id; validate all optional fields; call `repo.updateAction()`
   - `list_actions`: pass filters through, default status to 'active' if not provided

2. **Implement project tools** (create_project, update_project, list_projects):
   - Similar pattern to actions but simpler (fewer fields)
   - `list_projects` returns `ProjectWithCounts`

3. **Implement horizon tools** (upsert_horizon, list_horizons):
   - `upsert_horizon`: validate horizon is 2-5 integer, title required on create
   - `list_horizons`: horizon parameter is required

4. **Implement inbox tools** (capture_inbox, list_inbox, process_inbox_item):
   - `capture_inbox`: minimal validation (content required)
   - `process_inbox_item`: validate outcome_type enum, verify inbox item exists and belongs to user

5. **Implement `manage_shopping_list`**:
   - `add`: create action with `list_type='shopping'`, title=item name, category from param, store quantity in description
   - `remove`: find action by title where `list_type='shopping'`, status='active'; delete or mark dropped
   - `check_off`: find action by title where `list_type='shopping'`, mark completed
   - `list`: call `listActions(userId, { listType: 'shopping', status: 'active' })`, group by category, also fetch recently completed (last 24h) for the checked-off count

6. **Implement `recommend_actions`**:
   - Query all active todo actions for the user (exclude someday, shopping, waiting unless context matches)
   - Filter by start_date: exclude actions where `start_date > today`
   - Filter by energy: if criteria.energy provided, include actions where `energy <= criteria.energy` (low < medium < high)
   - Filter by context: if criteria.contextTags provided, include actions where `context` overlaps with tags
   - Score each action:
     - +3 if overdue
     - +2 if has due_date within 3 days
     - +1 if has due_date at all
     - +1 per matching context tag
     - +1 if energy matches exactly
   - Group into buckets:
     - `quick`: time_estimate <= 15 OR (time_estimate is null AND energy='low')
     - `medium`: time_estimate 16-60
     - `deep`: time_estimate > 60 OR energy='high'
     - Actions with null time_estimate and non-low energy go to medium
   - Sort within each group by score descending
   - Limit per group (default 5)
   - If `time_available` provided, filter: only include actions where `time_estimate <= time_available` (null time_estimate always included)

7. **Implement `get_gtd_health`**:
   - Call `repo.getHealth(userId)`, return directly
   - No parameters needed

8. **Error handling**:
   - FK violation (invalid project_id/area_id) -> ValidationError
   - Not found on update/process -> NotFoundError
   - Title search matching 0 or >1 -> appropriate error message

9. **Write tool tests**:
   - Test full action lifecycle: create -> list -> update -> complete -> list completed
   - Test project with actions: create project, create action linked to it, list projects shows count
   - Test inbox flow: capture -> list -> process
   - Test recommend_actions with various energy/context/time combos
   - Test get_gtd_health reflects correct counts
   - Test manage_shopping_list all operations

**Estimated effort:** Large

### Phase 3: Server Setup

**Steps:**

1. **Create entry point** `src/index.ts`:
   - Initialize pg Pool from `DATABASE_URL`
   - Run migrations on startup
   - Create repository instances
   - Create MCP server, register tools
   - Start with auth middleware
   - Graceful shutdown: drain pool

2. **Health endpoint**: ping PostgreSQL (`SELECT 1`)

3. **Docker**: `PACKAGE_NAME=mcp-gtd`, env vars: `DATABASE_URL`, `API_KEY`, `USER_ID`, `PORT`

4. **Smoke test**: create action, list actions, complete action, check health metrics

**Estimated effort:** Small

---

## MCP 3: awareness

**Storage:** Elasticsearch
**Tools:** 7 (get_current_location, query_location_history, query_im_messages, get_entity_statuses, get_calendar_events, get_situation, get_notable_events, acknowledge_events)
**Complexity:** Medium -- mostly read queries, but get_situation is a composite tool and geo queries add complexity

### Phase 1: Repository Layer

**Steps:**

1. **Define domain types** in `src/types.ts`:
   - `LocationRecord` (lat, lon, accuracy, timestamp, place_name, place_type, address, duration_minutes)
   - `MessageRecord` (id, timestamp, sender, app, content, conversation_id, conversation_name, is_group)
   - `MessageSearchResult` extends MessageRecord with relevance_score
   - `EntityStatusRecord` (entity_name, status_text, location, source, source_message_id, updated_at)
   - `CalendarEventRecord` (id, title, start, end, location, description, calendar_name, source, all_day, attendees)
   - `NotableEventRecord` (id, event_type, summary, severity, payload, created_at, acknowledged_at)
   - Enums: `Freshness` (live/recent/stale/unknown), `EventType` (place_arrival/urgent_im/calendar_soon/entity_status_change), `Severity` (low/medium/high)

2. **Define repository interfaces** in `src/repositories/interfaces.ts`:
   - `LocationRepository` -- store, getLatest, query
   - `MessageRepository` -- store, query
   - `EntityStatusRepository` -- upsert, getByName, listRecent
   - `CalendarEventRepository` -- upsert, query, getNext
   - `NotableEventRepository` -- create, queryUnacknowledged, acknowledge

3. **Implement ES index management** in `src/repositories/elasticsearch/indices.ts`:
   - 5 indices: `ll5_awareness_locations`, `ll5_awareness_messages`, `ll5_awareness_entity_statuses`, `ll5_awareness_calendar_events`, `ll5_awareness_notable_events`
   - Locations index: `geo_point` type for location field, `date` for timestamp
   - Messages index: multilingual analyzer on content, keyword on sender/app
   - Calendar events index: date range fields for start/end
   - Notable events index: keyword on event_type/severity, date on created_at/acknowledged_at
   - `ensureIndices()` idempotent creation on startup

4. **Implement `ElasticsearchLocationRepository`**:
   - `store(userId, location)` -- index document with user_id, all location fields, timestamp
   - `getLatest(userId)` -- query with `term: { user_id }`, `sort: [{ timestamp: "desc" }]`, `size: 1`
   - `query(userId, params)`:
     - `bool.filter`: user_id term + timestamp range (from/to)
     - Optional `place_filter`: `match` query on place_name with fuzziness
     - Optional `place_type_filter`: `term` on place_type
     - Sort by timestamp desc, apply limit
     - Compute `duration_minutes`: for consecutive points at same place, calculate time difference (can be done as post-processing or via ES scripted metric -- simpler to post-process)

5. **Implement `ElasticsearchMessageRepository`**:
   - `store(userId, message)` -- index with generated ID
   - `query(userId, params)`:
     - `bool.filter`: user_id, optional time range (default last 24h), optional app term, optional conversation_id term, optional is_group term
     - `bool.must` (if keyword): `multi_match` on content with fuzziness, also match on sender
     - `bool.filter` (if sender): `match` on sender with fuzziness (not term, because sender names vary)
     - Return relevance_score from ES `_score` when keyword search is used, null otherwise

6. **Implement `ElasticsearchEntityStatusRepository`**:
   - `upsert(userId, status)` -- use `update_by_query` or scripted upsert: find existing doc by `user_id + entity_name.keyword`, update if found, create if not; alternatively use a deterministic `_id = hash(userId + entity_name.lowercase)`
   - `getByName(userId, entity_name)` -- `match` query on entity_name with fuzziness, `filter` on user_id, return top hit
   - `listRecent(userId, params)` -- `filter` on user_id, optional `range` on updated_at (since param, default 24h), sort by updated_at desc

7. **Implement `ElasticsearchCalendarEventRepository`**:
   - `upsert(userId, event)` -- use `_id = hash(userId + source + event.id)` for deterministic upserts
   - `query(userId, params)`:
     - `filter` on user_id
     - Time range: events where `start <= to AND end >= from` (overlapping range)
     - Optional calendar_name filter
     - If `include_all_day=false`, add `term: { all_day: false }`
     - Sort by start asc
   - `getNext(userId)` -- `filter`: user_id, `start > now`, sort by start asc, size 1

8. **Implement `ElasticsearchNotableEventRepository`**:
   - `create(userId, event)` -- index with generated ID, acknowledged_at=null
   - `queryUnacknowledged(userId, params)`:
     - `filter`: user_id, `must_not: { exists: { field: "acknowledged_at" } }` (or `term: { acknowledged_at: null }` -- use must_not exists)
     - Optional: `range` on created_at (since param, default 1h)
     - Optional: `term` on event_type
     - Optional: severity filter (map severity to numeric for range, or use terms with allowed values)
     - Sort by severity desc (high first), then created_at desc
   - `acknowledge(userId, eventIds)` -- `update_by_query` with filter on user_id + ids, set `acknowledged_at = now()`; return count of updated docs

**Estimated effort:** Medium

### Phase 2: MCP Tools

**Steps:**

1. **Implement `get_current_location`**:
   - Call `locationRepo.getLatest(userId)`
   - Compute freshness based on timestamp vs. now: <5min = live, <30min = recent, <2hr = stale, else unknown
   - Return location record with computed freshness

2. **Implement `query_location_history`**:
   - Validate `from` and `to` are valid ISO dates, `from < to`
   - Pass through to `locationRepo.query()`
   - Post-process: compute duration_minutes for consecutive points at the same place

3. **Implement `query_im_messages`**:
   - Default `from` to 24h ago, `to` to now if not provided
   - Pass filters to `messageRepo.query()`
   - Return results directly

4. **Implement `get_entity_statuses`**:
   - If `entity_name` provided, call `entityStatusRepo.getByName()`, return as single-element array (or empty if not found)
   - Otherwise call `entityStatusRepo.listRecent()` with since/limit params

5. **Implement `get_calendar_events`**:
   - Default `from` to start of today (in user's timezone), `to` to end of today
   - Pass to `calendarEventRepo.query()`
   - Return events sorted by start time

6. **Implement `get_situation`** (composite tool):
   - Run in parallel:
     - `locationRepo.getLatest(userId)` -- current location
     - `calendarEventRepo.getNext(userId)` -- next event
     - `notableEventRepo.queryUnacknowledged(userId, { since: '1h ago' })` -- recent notable events
     - `messageRepo.query(userId, { from: '1h ago' })` -- count active conversations
   - Compute:
     - `current_time`: ISO string of now
     - `timezone`: from user profile (passed in or configured) or from latest location's device_timezone
     - `time_period`: based on current hour in user's timezone (morning 6-12, afternoon 12-17, evening 17-21, night 21-6)
     - `day_type`: weekday or weekend based on current day
     - `current_location`: from getLatest, with freshness
     - `next_event`: from getNext, null if none
     - `time_until_next_event`: human-readable duration ("in 45 minutes", "in 2 hours")
     - `suggested_energy`: heuristic -- morning/afternoon + sparse schedule = high; evening = medium; night or packed schedule = low
     - `notable_recent_events`: from queryUnacknowledged
     - `active_conversations`: count distinct conversation_ids from recent messages

7. **Implement `get_notable_events`**:
   - Pass filters to `notableEventRepo.queryUnacknowledged()`
   - Default since to 1h ago

8. **Implement `acknowledge_events`**:
   - Validate event_ids is non-empty array
   - Call `notableEventRepo.acknowledge(userId, eventIds)`
   - Return acknowledged count

9. **Error handling**:
   - Empty results are not errors -- return empty arrays
   - Invalid date ranges -> ValidationError
   - ES query failures -> log and return generic error

10. **Write tool tests**:
    - Test get_situation returns all composite fields
    - Test location freshness computation
    - Test notable events acknowledgment flow
    - Test message search with keyword vs. without

**Estimated effort:** Medium

### Phase 3: Server Setup

Same pattern as personal-knowledge. Environment variables: `ELASTICSEARCH_URL`, `ELASTICSEARCH_API_KEY`, `API_KEY`, `USER_ID`, `PORT`.

**Estimated effort:** Small

---

## MCP 4: google

**Storage:** PostgreSQL
**Tools:** 8 (OAuth: 3, Calendar: 3, Gmail: 2)
**Complexity:** Large -- OAuth flow, token encryption, Google API integration, two different Google APIs

### Phase 1: OAuth Flow

**Steps:**

1. **Define domain types** in `src/types.ts`:
   - `OAuthTokenRecord` (user_id, access_token, refresh_token, token_type, expires_at, scopes, timestamps)
   - `CalendarConfigRecord` (user_id, calendar_id, calendar_name, enabled, color, timestamps)
   - Google API response types (calendar event, email message, calendar list entry)

2. **Set up Google OAuth2 client**:
   - Use `googleapis` npm package (`google.auth.OAuth2`)
   - Configure with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` from env
   - Scopes: `calendar.readonly`, `calendar.events`, `gmail.readonly`, `gmail.send`

3. **Implement token encryption**:
   - Use `crypto.createCipheriv()` / `crypto.createDecipheriv()` with AES-256-GCM
   - Encryption key from `TOKEN_ENCRYPTION_KEY` env var (32-byte hex string)
   - `encrypt(plaintext) -> { ciphertext, iv, authTag }` -- store as single base64 string
   - `decrypt(encrypted) -> plaintext`
   - Encrypt access_token and refresh_token before storage, decrypt on retrieval

4. **Write SQL migrations**:
   - `001_create_google_oauth_tokens.sql` -- table with encrypted token columns, unique on user_id
   - `002_create_google_calendar_config.sql` -- table with unique on (user_id, calendar_id)

5. **Implement `PostgresOAuthTokenRepository`**:
   - `store(userId, tokens)` -- encrypt access_token and refresh_token, INSERT or UPDATE (upsert on user_id)
   - `get(userId)` -- SELECT, decrypt tokens, return record or null
   - `updateAccessToken(userId, accessToken, expiresAt)` -- encrypt new access token, UPDATE
   - `delete(userId)` -- DELETE by user_id

6. **Implement token refresh logic** in `src/google/auth.ts`:
   - `getValidClient(userId)` -- get tokens from repo, check if expired, refresh if needed, return authenticated OAuth2 client
   - Refresh flow: call `oauth2Client.refreshAccessToken()`, save new access_token and expiry via `repo.updateAccessToken()`
   - Handle refresh token revocation: if refresh fails with `invalid_grant`, delete tokens and return error indicating re-auth needed

7. **Implement `PostgresCalendarConfigRepository`**:
   - `upsert(userId, config)` -- INSERT ON CONFLICT (user_id, calendar_id) DO UPDATE
   - `list(userId)` -- SELECT all for user
   - `setEnabled(userId, calendarId, enabled)` -- UPDATE enabled column
   - `getEnabledCalendarIds(userId)` -- SELECT calendar_id WHERE user_id=$1 AND enabled=true
   - `deleteAll(userId)` -- DELETE WHERE user_id=$1

8. **Implement OAuth tool handlers**:
   - `get_auth_url`: generate OAuth2 URL with state token (random UUID stored temporarily or signed), return URL
   - `handle_oauth_callback`: validate state, exchange code for tokens, encrypt and store, fetch user email via `oauth2.userinfo.get()`, return success
   - `get_connection_status`: check if tokens exist, if access_token is expired, return status
   - `disconnect`: revoke token at Google (`oauth2Client.revokeToken()`), delete from DB, delete calendar config

**Estimated effort:** Large

### Phase 2: Calendar Tools

**Steps:**

1. **Implement `list_calendars`**:
   - Get authenticated client via `getValidClient(userId)`
   - Call `google.calendar('v3').calendarList.list()`
   - Map response to CalendarConfigRecord, upsert each into local config (preserving existing enabled settings)
   - Merge Google data with local config (enabled status, color overrides)
   - Return merged list

2. **Implement `list_events`**:
   - Get enabled calendar IDs (or use specific calendar_id if provided)
   - For each enabled calendar, call `google.calendar('v3').events.list()` with:
     - `timeMin` = from (default: start of today)
     - `timeMax` = to (default: end of today)
     - `q` = query (if provided)
     - `maxResults` = max_results
     - `singleEvents: true` (expand recurring events)
     - `orderBy: 'startTime'`
   - Merge results from all calendars, sort by start time
   - Filter out all-day events if `include_all_day=false`
   - Map Google event format to tool response format

3. **Implement `create_event`**:
   - Get authenticated client
   - Build event resource from parameters
   - Handle all_day events: use `date` instead of `dateTime` in start/end
   - Call `google.calendar('v3').events.insert()`
   - Return created event ID and link

4. **Handle Google API errors**:
   - 401/403: token may be revoked, attempt refresh, retry once
   - 404: calendar not found
   - Rate limits: respect `Retry-After` header
   - Wrap all Google API calls in error handler that provides clean error messages

**Estimated effort:** Medium

### Phase 3: Gmail Tools

**Steps:**

1. **Implement `list_emails`**:
   - Get authenticated client
   - Build Gmail search query string: combine `query`, `label` (as `label:LABEL`), date range (`after:YYYY/MM/DD before:YYYY/MM/DD`)
   - Call `google.gmail('v1').users.messages.list()` with query
   - For each message ID, call `google.gmail('v1').users.messages.get()` to fetch full message
   - Parse email headers (From, To, Cc, Subject, Date) from message payload
   - Extract body: prefer text/plain part, fall back to text/html with stripping
   - If `include_body=false`, skip body extraction (return headers + snippet only)
   - Map to response format

2. **Implement `send_email`**:
   - Get authenticated client
   - Build MIME message using raw format:
     - Set From (user's email from token), To, Cc, Bcc, Subject headers
     - If `reply_to_message_id` provided, fetch original message to get `Message-ID` header, set `In-Reply-To` and `References` headers, use same `threadId`
     - Set body as text/plain
   - Base64url encode the MIME message
   - Call `google.gmail('v1').users.messages.send()` with raw encoded message
   - Return message_id and thread_id

3. **Handle Gmail-specific errors**:
   - Sending errors: invalid recipients, message too large
   - Search errors: invalid query syntax

**Estimated effort:** Medium

### Phase 4: Server Setup

Same pattern. Environment variables: `DATABASE_URL`, `API_KEY`, `USER_ID`, `PORT`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY`.

**Estimated effort:** Small

---

## MCP 5: messaging

**Storage:** PostgreSQL
**Tools:** 7 (list_accounts, send_whatsapp, send_telegram, list_conversations, update_conversation_permissions, read_messages, sync_whatsapp_conversations, get_account_status)
**Complexity:** Medium -- two external APIs, but both are relatively simple HTTP clients; permission enforcement adds a layer

### Phase 1: WhatsApp Integration

**Steps:**

1. **Define domain types** in `src/types.ts`:
   - `WhatsAppAccountRecord` (id, user_id, instance_name, instance_id, api_url, api_key, phone_number, status, last_seen_at, timestamps)
   - `TelegramAccountRecord` (id, user_id, bot_token, bot_username, bot_name, status, last_seen_at, timestamps)
   - `ConversationRecord` (id, user_id, account_id, platform, conversation_id, name, is_group, permission, last_message_at, timestamps)
   - `MessageResult` (message_id, timestamp, sender_name, sender_id, content, is_from_bot, is_group, reply_to_message_id)
   - Enums: `Platform`, `Permission`, `AccountStatus`

2. **Write SQL migrations**:
   - `001_create_messaging_whatsapp_accounts.sql`
   - `002_create_messaging_telegram_accounts.sql`
   - `003_create_messaging_conversations.sql` -- with unique constraint on (user_id, platform, conversation_id), indexes on user_id

3. **Implement Evolution API client** in `src/clients/evolution.ts`:
   - HTTP client wrapper for Evolution API endpoints
   - `sendMessage(instanceName, apiUrl, apiKey, to, message)` -- POST to `/message/sendText/{instanceName}`
   - `fetchConversations(instanceName, apiUrl, apiKey)` -- GET conversations/chats list
   - `fetchMessages(instanceName, apiUrl, apiKey, conversationId, limit)` -- GET messages from a conversation
   - `checkHealth(instanceName, apiUrl, apiKey)` -- GET instance connection status
   - All methods handle HTTP errors, parse Evolution API response format
   - API key decryption happens before passing to client (client receives plaintext)

4. **Implement `PostgresAccountRepository`**:
   - `listWhatsApp(userId)` -- SELECT from messaging_whatsapp_accounts WHERE user_id=$1
   - `getWhatsApp(userId, accountId)` -- SELECT by id and user_id, decrypt api_key
   - `listTelegram(userId)`, `getTelegram(userId, accountId)` -- same pattern, decrypt bot_token
   - `updateStatus(userId, accountId, status, lastError?)` -- UPDATE status and last_seen_at
   - Encrypt api_key and bot_token at rest using same AES-256-GCM pattern as google MCP (share encryption utility via `@ll5/storage`)

5. **Implement `PostgresConversationRepository`**:
   - `list(userId, params)` -- SELECT with optional filters (platform, permission, account_id, is_group), LIMIT
   - `get(userId, platform, conversationId)` -- SELECT by unique constraint fields
   - `upsert(userId, conversation)` -- INSERT ON CONFLICT (user_id, platform, conversation_id) DO UPDATE name, is_group (preserve permission)
   - `updatePermission(userId, platform, conversationId, permission)` -- UPDATE, return previous value
   - `touchLastMessage(userId, platform, conversationId, timestamp)` -- UPDATE last_message_at

6. **Implement WhatsApp tool handlers**:
   - `send_whatsapp`:
     - Get account, verify status='connected'
     - Check conversation permission: look up conversation by (platform='whatsapp', to as conversation_id); if found, must be 'agent' permission; if not found, auto-create with 'agent' permission (first contact)
     - Call Evolution API sendMessage
     - Update last_message_at on conversation
     - Return success/failure
   - `sync_whatsapp_conversations`:
     - Get account, fetch conversation list from Evolution API
     - For each conversation, upsert into conversations table (preserves existing permissions)
     - Return counts (total, new, updated)

7. **Implement `read_messages`** (WhatsApp path):
   - Get account for the conversation
   - Check conversation permission: must be 'agent' or 'input', deny if 'ignore'
   - Fetch messages from Evolution API
   - Map to `MessageResult` format
   - Filter by `since` timestamp if provided

**Estimated effort:** Medium

### Phase 2: Telegram Integration

**Steps:**

1. **Implement Telegram Bot API client** in `src/clients/telegram.ts`:
   - HTTP client for Telegram Bot API (base URL: `https://api.telegram.org/bot{token}/`)
   - `sendMessage(botToken, chatId, text, parseMode?)` -- POST to `/sendMessage`
   - `getUpdates(botToken, offset?, limit?)` -- GET `/getUpdates` for fetching messages
   - `getChat(botToken, chatId)` -- GET `/getChat` for conversation details
   - `getMe(botToken)` -- GET `/getMe` for bot info and health check
   - Handle Telegram API error responses (error_code, description)

2. **Implement Telegram tool handlers**:
   - `send_telegram`:
     - Get Telegram account, verify status='connected'
     - Check conversation permission (same logic as WhatsApp)
     - Call Telegram sendMessage API
     - Return success with message_id
   - `read_messages` (Telegram path):
     - Check permission
     - Fetch recent messages via getUpdates (filtered to the specific chat_id)
     - Note: Telegram Bot API getUpdates returns all messages across all chats, so filter by chat_id client-side
     - Map to `MessageResult` format

3. **Implement shared tool handlers**:
   - `list_accounts`: query both WhatsApp and Telegram accounts, merge into unified response, check health status for each
   - `list_conversations`: query conversations table with filters
   - `update_conversation_permissions`: update permission, return old/new values
   - `get_account_status`:
     - Determine platform from account_id (query both tables)
     - For WhatsApp: call Evolution API health check
     - For Telegram: call getMe to verify bot token
     - Return detailed status including last_error if disconnected

**Estimated effort:** Medium

### Phase 3: Server Setup

Same pattern. Environment variables: `DATABASE_URL`, `API_KEY`, `USER_ID`, `PORT`, `TOKEN_ENCRYPTION_KEY`.

Note: WhatsApp/Telegram credentials (Evolution API URLs, API keys, bot tokens) are stored in the database per-account, not in environment variables. The only env-level secret is the encryption key for those credentials.

**Estimated effort:** Small

---

## Implementation Order

Build order is driven by two factors: user value (what makes the system useful earliest) and dependencies (what other components need).

### Recommended Order

| Order | MCP | Rationale | Effort |
|-------|-----|-----------|--------|
| 1 | **Shared Foundation** | Everything depends on this. Establish project structure, shared packages, Docker pattern, auth middleware. | Medium |
| 2 | **personal-knowledge** | Highest standalone value. Gives the assistant memory -- who the user is, who they know, what they prefer. No external API dependencies, straightforward ES CRUD+search. Good first MCP to validate the full stack (build, deploy, connect from Claude Code). | Medium |
| 3 | **gtd** | Core productivity value. The GTD system is the primary workflow the assistant supports. Most tools, most complexity, but no external dependencies beyond PostgreSQL. | Large |
| 4 | **awareness** | Enables proactive behavior. Once the gateway is also built, the system can track location, messages, and calendar events. The `get_situation` tool is what makes the assistant context-aware. Build after gtd because the `/engage` and `/daily` skills need both. | Medium |
| 5 | **google** | Calendar and email integration. Requires OAuth setup and Google Cloud project configuration. Build after awareness because calendar events from Google can be cached in awareness. | Large |
| 6 | **messaging** | Outbound communication. Requires Evolution API instance (WhatsApp) and Telegram bot setup. Least critical for core functionality -- the user can send messages themselves. Build last. | Medium |

### Effort Summary

| Component | Effort | Estimated Duration |
|-----------|--------|--------------------|
| Shared Foundation | Medium | 2-3 days |
| personal-knowledge (all phases) | Medium | 3-4 days |
| gtd (all phases) | Large | 5-7 days |
| awareness (all phases) | Medium | 3-4 days |
| google (all phases) | Large | 4-6 days |
| messaging (all phases) | Medium | 3-4 days |
| **Total** | | **20-28 days** |

### Parallelization Opportunities

- After Shared Foundation is complete, personal-knowledge and gtd can be built in parallel (they share no dependencies).
- awareness and google can be built in parallel (awareness reads ES, google reads PG -- no overlap).
- messaging is fully independent and can overlap with google if needed.

### First Milestone: Minimum Viable Assistant

Build Shared Foundation + personal-knowledge + gtd. This gives the assistant:
- Memory (who the user is, preferences, people, places)
- GTD system (actions, projects, inbox, reviews, recommendations)
- Enough to run `/daily`, `/clarify`, `/engage`, `/sweep`, `/plan` skills

Estimated time to first milestone: **10-14 days**.
