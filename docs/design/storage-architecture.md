# Storage Architecture

How data is stored, accessed, and abstracted across the system.

---

## Storage Engines

### Elasticsearch

Used by: `personal-knowledge` MCP, `awareness` MCP

**Why:**
- Fuzzy search ("Yael" / "יעל" / "yael" all match)
- Full-text search across all fields without predefined search columns
- Schema flexibility — add fields without migrations
- Geo queries (distance from point, bounding box)
- Time-range queries on push data
- Hebrew + English text analysis

**Version:** 8.x (or OpenSearch 2.x as drop-in replacement)

### PostgreSQL

Used by: `gtd` MCP, `google` MCP, `messaging` MCP

**Why:**
- ACID transactions for state transitions (action: active → completed)
- Relational queries (count actions per project, join inbox to outcomes)
- Precise filtering (status AND list_type AND energy AND context)
- Read-after-write consistency (mark complete → immediately reflect in counts)
- Proven, simple, well-tooled

**Version:** 16.x

---

## Storage Abstraction Layer

Every MCP accesses storage through a repository interface. The interface defines domain operations. The implementation chooses the engine and query language.

### Pattern

```typescript
// The interface — lives in the MCP's domain layer
interface FactRepository {
  find(userId: string, filters: FactFilters): Promise<Fact[]>;
  search(userId: string, query: string, options?: SearchOptions): Promise<Fact[]>;
  findById(userId: string, id: string): Promise<Fact | null>;
  create(userId: string, data: CreateFactInput): Promise<Fact>;
  update(userId: string, id: string, data: UpdateFactInput): Promise<Fact>;
  delete(userId: string, id: string): Promise<void>;
}

// Elasticsearch implementation
class ElasticsearchFactRepository implements FactRepository {
  async find(userId: string, filters: FactFilters): Promise<Fact[]> {
    // ES query with user_id filter
  }
  async search(userId: string, query: string): Promise<Fact[]> {
    // ES multi_match with fuzzy
  }
}

// In-memory implementation for tests
class InMemoryFactRepository implements FactRepository {
  private store: Map<string, Fact[]> = new Map();
  // ...
}
```

### Rules

1. **No query language in domain code.** The repository implementation translates domain operations into ES queries or SQL. The MCP's tool handlers never see `{ bool: { must: [...] } }` or `SELECT ... FROM`.

2. **User scoping is mandatory.** Every repository method takes `userId` as its first parameter. Implementations must filter by user — this is not optional, not a convenience, it's a security boundary.

3. **Return domain objects, not DB rows.** The repository maps storage results to typed domain objects. If ES returns `_source` with `_id`, the repository returns a clean `Fact` object.

4. **One repository per entity type.** Not one mega-repository. `FactRepository`, `PersonRepository`, `PlaceRepository` — each focused.

5. **Search is a first-class operation.** Not an afterthought bolted onto CRUD. The interface defines `search()` with support for fuzzy matching, relevance scoring, and highlights.

---

## Elasticsearch Index Design

### Naming Convention

```
ll5_{mcp}_{entity}    (e.g., ll5_knowledge_facts, ll5_awareness_locations)
```

### Index: `ll5_knowledge_facts`

```json
{
  "mappings": {
    "properties": {
      "user_id":     { "type": "keyword" },
      "type":        { "type": "keyword" },
      "category":    { "type": "keyword" },
      "content":     { "type": "text", "analyzer": "multilingual" },
      "provenance":  { "type": "keyword" },
      "confidence":  { "type": "float" },
      "source":      { "type": "keyword" },
      "tags":        { "type": "keyword" },
      "created_at":  { "type": "date" },
      "updated_at":  { "type": "date" }
    }
  }
}
```

### Index: `ll5_knowledge_people`

```json
{
  "mappings": {
    "properties": {
      "user_id":       { "type": "keyword" },
      "name":          { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "aliases":       { "type": "text" },
      "relationship":  { "type": "keyword" },
      "contact_info":  { "type": "object", "enabled": false },
      "tags":          { "type": "keyword" },
      "notes":         { "type": "text", "analyzer": "multilingual" },
      "created_at":    { "type": "date" },
      "updated_at":    { "type": "date" }
    }
  }
}
```

### Index: `ll5_knowledge_places`

```json
{
  "mappings": {
    "properties": {
      "user_id":     { "type": "keyword" },
      "name":        { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "type":        { "type": "keyword" },
      "address":     { "type": "text" },
      "location":    { "type": "geo_point" },
      "tags":        { "type": "keyword" },
      "created_at":  { "type": "date" },
      "updated_at":  { "type": "date" }
    }
  }
}
```

### Index: `ll5_awareness_locations`

```json
{
  "mappings": {
    "properties": {
      "user_id":          { "type": "keyword" },
      "location":         { "type": "geo_point" },
      "accuracy":         { "type": "float" },
      "speed":            { "type": "float" },
      "address":          { "type": "text" },
      "matched_place_id": { "type": "keyword" },
      "matched_place":    { "type": "keyword" },
      "device_timezone":  { "type": "keyword" },
      "timestamp":        { "type": "date" }
    }
  }
}
```

### Index: `ll5_awareness_messages`

```json
{
  "mappings": {
    "properties": {
      "user_id":    { "type": "keyword" },
      "sender":     { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "app":        { "type": "keyword" },
      "content":    { "type": "text", "analyzer": "multilingual" },
      "processed":  { "type": "boolean" },
      "timestamp":  { "type": "date" }
    }
  }
}
```

### Index: `ll5_awareness_entity_statuses`

```json
{
  "mappings": {
    "properties": {
      "user_id":    { "type": "keyword" },
      "entity_name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
      "summary":    { "type": "text" },
      "location":   { "type": "text" },
      "activity":   { "type": "text" },
      "source":     { "type": "keyword" },
      "timestamp":  { "type": "date" }
    }
  }
}
```

### Custom Analyzer: `multilingual`

```json
{
  "settings": {
    "analysis": {
      "analyzer": {
        "multilingual": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "hebrew_stemmer"]
        }
      }
    }
  }
}
```

Supports both Hebrew and English text. The `asciifolding` filter normalizes diacritics. A custom Hebrew stemmer plugin or ICU analysis can be added for deeper Hebrew support.

---

## PostgreSQL Schema Design

### Naming Convention

```
All tables prefixed by MCP: gtd_, google_, messaging_
All tables include user_id column
All tables include created_at, updated_at timestamps
```

### GTD MCP Tables

```sql
-- Unified horizons table (h=0 through h=5)
CREATE TABLE gtd_horizons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  horizon     SMALLINT NOT NULL CHECK (horizon BETWEEN 0 AND 5),
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',

  -- Action-specific (horizon 0)
  energy      TEXT CHECK (energy IN ('low', 'medium', 'high')),
  list_type   TEXT CHECK (list_type IN ('todo', 'shopping', 'waiting', 'someday')),
  context     JSONB DEFAULT '[]',
  due_date    DATE,
  start_date  DATE,
  project_id  UUID REFERENCES gtd_horizons(id),
  area_id     UUID REFERENCES gtd_horizons(id),
  waiting_for TEXT,
  time_estimate TEXT,
  category    TEXT,
  completed_at TIMESTAMPTZ,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gtd_horizons_user ON gtd_horizons(user_id);
CREATE INDEX idx_gtd_horizons_user_horizon ON gtd_horizons(user_id, horizon);
CREATE INDEX idx_gtd_horizons_user_status ON gtd_horizons(user_id, status);
CREATE INDEX idx_gtd_horizons_project ON gtd_horizons(project_id);
CREATE INDEX idx_gtd_horizons_due ON gtd_horizons(user_id, due_date) WHERE due_date IS NOT NULL;
CREATE INDEX idx_gtd_horizons_start ON gtd_horizons(user_id, start_date) WHERE start_date IS NOT NULL;

-- GTD inbox
CREATE TABLE gtd_inbox (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  content     TEXT NOT NULL,
  source      TEXT DEFAULT 'direct',
  source_link TEXT,
  status      TEXT NOT NULL DEFAULT 'captured' CHECK (status IN ('captured', 'reviewed', 'processed')),
  suggested_outcome JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gtd_inbox_user_status ON gtd_inbox(user_id, status);

-- Review session tracking
CREATE TABLE gtd_review_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  type            TEXT NOT NULL CHECK (type IN ('daily', 'weekly', 'horizons')),
  status          TEXT NOT NULL DEFAULT 'in_progress',
  current_phase   TEXT,
  phase_data      JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_gtd_reviews_user ON gtd_review_sessions(user_id);
```

### Google MCP Tables

```sql
CREATE TABLE google_oauth_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE,
  access_token  TEXT NOT NULL,  -- encrypted at rest
  refresh_token TEXT NOT NULL,  -- encrypted at rest
  expiry        TIMESTAMPTZ NOT NULL,
  scopes        TEXT[],
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE google_calendar_config (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  calendar_id  TEXT NOT NULL,
  name         TEXT,
  enabled      BOOLEAN DEFAULT true,
  UNIQUE(user_id, calendar_id)
);
```

### Messaging MCP Tables

```sql
CREATE TABLE messaging_whatsapp_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  instance_id  TEXT NOT NULL,
  account_type TEXT DEFAULT 'personal',
  enabled      BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messaging_telegram_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  bot_token    TEXT NOT NULL,  -- encrypted at rest
  enabled      BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE messaging_conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  platform     TEXT NOT NULL CHECK (platform IN ('whatsapp', 'telegram')),
  external_id  TEXT NOT NULL,
  name         TEXT,
  permissions  TEXT DEFAULT 'ignore' CHECK (permissions IN ('agent', 'input', 'ignore')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, platform, external_id)
);
```

---

## Multi-Tenancy in Storage

### Elasticsearch

Every document includes a `user_id` field (type: `keyword`). Every query wraps in a `bool.filter` with `term: { user_id }`. No index-per-user — single shared indices with query-time filtering. This scales well up to millions of users; if needed later, index-per-tenant is a straightforward migration.

### PostgreSQL

Every table includes a `user_id` column (type: `UUID`). Every query includes `WHERE user_id = $1`. Consider PostgreSQL Row-Level Security (RLS) policies for defense-in-depth:

```sql
ALTER TABLE gtd_horizons ENABLE ROW LEVEL SECURITY;
CREATE POLICY gtd_horizons_user_isolation ON gtd_horizons
  USING (user_id = current_setting('app.current_user_id')::UUID);
```

RLS is optional but adds a safety net — even a buggy query can't leak data across users.

---

## Backup and Recovery

### Elasticsearch

- ES Snapshot API to S3-compatible storage (daily)
- Index lifecycle management for time-series data (awareness locations/messages)
- Retention: locations 90 days, messages 30 days, knowledge indefinite

### PostgreSQL

- `pg_dump` daily, retained 30 days
- WAL archiving for point-in-time recovery if needed
- All GTD and config data retained indefinitely

---

## Connection Management

Each MCP maintains its own connection pool to its storage engine. No shared pools, no cross-MCP connections.

```typescript
// Each MCP initializes its own client
const esClient = new Client({
  node: process.env.ELASTICSEARCH_URL,
  auth: { apiKey: process.env.ELASTICSEARCH_API_KEY }
});

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10  // single-user; increase for multi-tenant
});
```

Environment variables per MCP. No hardcoded connection strings. No shared config files.
