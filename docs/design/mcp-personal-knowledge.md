# MCP: personal-knowledge

**Domain:** User identity, facts, people, places, preferences, data gaps.
**Storage:** Elasticsearch (fuzzy search, full-text, schema flexibility, multilingual Hebrew+English)
**Transport:** HTTP+SSE (remote deployment)

## Purpose

The structured knowledge base about the user and their world. Queried for context loading, searched for relevance, written to when learning new information. Stores facts with provenance (user-stated, inferred, observed) and confidence scores.

This MCP is the authoritative source for who the user is, what they know, who they know, and where they go. It is queried at the start of conversations for context and updated as new information surfaces. It does not call other MCPs.

---

## Tools

### Profile

#### get_profile

Retrieve the user's profile.

| Parameter | Type     | Required | Description          |
|-----------|----------|----------|----------------------|
| -         | -        | -        | No parameters needed |

**Returns:**

```json
{
  "profile": {
    "user_id": "string",
    "name": "string",
    "timezone": "string",
    "location": "string",
    "bio": "string",
    "birth_date": "string | null (ISO 8601 date)",
    "languages": "string[]",
    "created_at": "string (ISO 8601)",
    "updated_at": "string (ISO 8601)"
  }
}
```

#### update_profile

Update fields on the user's profile. Only provided fields are changed.

| Parameter    | Type        | Required | Description                          |
|--------------|-------------|----------|--------------------------------------|
| name         | string      | no       | Display name                         |
| timezone     | string      | no       | IANA timezone (e.g. Asia/Jerusalem)  |
| location     | string      | no       | Free-text current location           |
| bio          | string      | no       | Short biography                      |
| birth_date   | string      | no       | ISO 8601 date (YYYY-MM-DD)          |
| languages    | string[]    | no       | Spoken languages                     |

**Returns:**

```json
{
  "profile": { "...updated profile object" }
}
```

---

### Cross-Entity Search

#### search_knowledge

Full-text fuzzy search across all knowledge entities (facts, people, places). Results are relevance-scored and unified.

| Parameter  | Type     | Required | Description                                              |
|------------|----------|----------|----------------------------------------------------------|
| query      | string   | yes      | Free-text search query (Hebrew or English)               |
| entity_types | string[] | no     | Filter to specific types: `fact`, `person`, `place`. Default: all. |
| limit      | number   | no       | Max results to return. Default: 20. Max: 100.            |
| min_score  | number   | no       | Minimum relevance score (0.0-1.0). Default: 0.1.        |
| tags       | string[] | no       | Filter results that have ALL of these tags               |

**Returns:**

```json
{
  "results": [
    {
      "entity_type": "fact | person | place",
      "entity_id": "string",
      "score": "number (0.0-1.0)",
      "highlight": "string (matched fragment with <em> markers)",
      "summary": "string (entity-specific summary line)",
      "data": { "...full entity object" }
    }
  ],
  "total": "number"
}
```

---

### Facts

#### list_facts

List facts with optional filters. Sorted by updated_at descending.

| Parameter   | Type     | Required | Description                                       |
|-------------|----------|----------|---------------------------------------------------|
| type        | string   | no       | Filter by fact type: `preference`, `habit`, `biographical`, `medical`, `dietary`, `technical`, `opinion`, `other` |
| category    | string   | no       | Filter by category (free-text, e.g. "food", "work") |
| tags        | string[] | no       | Filter by tags (AND logic)                        |
| provenance  | string   | no       | Filter by provenance: `user-stated`, `inferred`, `observed` |
| min_confidence | number | no     | Minimum confidence score (0.0-1.0)                |
| query       | string   | no       | Free-text search within facts                     |
| limit       | number   | no       | Max results. Default: 50. Max: 200.               |
| offset      | number   | no       | Pagination offset. Default: 0.                    |

**Returns:**

```json
{
  "facts": [
    {
      "id": "string",
      "user_id": "string",
      "type": "string",
      "category": "string",
      "content": "string",
      "provenance": "user-stated | inferred | observed",
      "confidence": "number (0.0-1.0)",
      "tags": "string[]",
      "source": "string | null (where this fact was learned)",
      "valid_from": "string | null (ISO 8601)",
      "valid_until": "string | null (ISO 8601)",
      "created_at": "string (ISO 8601)",
      "updated_at": "string (ISO 8601)"
    }
  ],
  "total": "number"
}
```

#### get_fact

Retrieve a single fact by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Fact ID     |

**Returns:**

```json
{
  "fact": { "...fact object" }
}
```

#### upsert_fact

Create a new fact or update an existing one. If `id` is provided, updates that fact. Otherwise creates a new one (deduplication by content similarity is applied).

| Parameter   | Type     | Required | Description                                       |
|-------------|----------|----------|---------------------------------------------------|
| id          | string   | no       | Fact ID to update. Omit to create new.            |
| type        | string   | yes      | `preference`, `habit`, `biographical`, `medical`, `dietary`, `technical`, `opinion`, `other` |
| category    | string   | yes      | Free-text category (e.g. "food", "work", "family") |
| content     | string   | yes      | The fact itself, in natural language               |
| provenance  | string   | yes      | `user-stated`, `inferred`, `observed`              |
| confidence  | number   | yes      | Confidence score 0.0-1.0                           |
| tags        | string[] | no       | Tags for categorization. Default: [].              |
| source      | string   | no       | Where this fact was learned (conversation, observation, etc.) |
| valid_from  | string   | no       | ISO 8601 date when this fact became true           |
| valid_until | string   | no       | ISO 8601 date when this fact expires/expired       |

**Returns:**

```json
{
  "fact": { "...fact object" },
  "created": "boolean (true if new, false if updated)"
}
```

#### delete_fact

Delete a fact by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Fact ID     |

**Returns:**

```json
{
  "deleted": true
}
```

---

### People

#### list_people

List people in the user's network with optional filters.

| Parameter    | Type     | Required | Description                                     |
|--------------|----------|----------|-------------------------------------------------|
| relationship | string   | no       | Filter by relationship (e.g. "friend", "family", "colleague") |
| tags         | string[] | no       | Filter by tags (AND logic)                      |
| query        | string   | no       | Free-text search across name, aliases, notes    |
| limit        | number   | no       | Max results. Default: 50. Max: 200.             |
| offset       | number   | no       | Pagination offset. Default: 0.                  |

**Returns:**

```json
{
  "people": [
    {
      "id": "string",
      "user_id": "string",
      "name": "string",
      "aliases": "string[] (Hebrew+English variants, nicknames)",
      "relationship": "string",
      "contact_info": {
        "email": "string | null",
        "phone": "string | null",
        "other": "Record<string, string>"
      },
      "tags": "string[]",
      "notes": "string",
      "created_at": "string (ISO 8601)",
      "updated_at": "string (ISO 8601)"
    }
  ],
  "total": "number"
}
```

#### get_person

Retrieve a single person by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Person ID   |

**Returns:**

```json
{
  "person": { "...person object" }
}
```

#### upsert_person

Create or update a person record.

| Parameter    | Type     | Required        | Description                                   |
|--------------|----------|-----------------|-----------------------------------------------|
| id           | string   | no              | Person ID to update. Omit to create new.      |
| name         | string   | yes (on create) | Primary display name                          |
| aliases      | string[] | no              | Alternative names (Hebrew+English, nicknames) |
| relationship | string   | no              | Relationship to user (free-text)              |
| contact_info | object   | no              | `{ email?, phone?, other?: Record<string, string> }` |
| tags         | string[] | no              | Tags for categorization                       |
| notes        | string   | no              | Free-text notes about this person             |

**Returns:**

```json
{
  "person": { "...person object" },
  "created": "boolean"
}
```

#### delete_person

Delete a person by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Person ID   |

**Returns:**

```json
{
  "deleted": true
}
```

---

### Places

#### list_places

List places with optional filters.

| Parameter | Type     | Required | Description                                        |
|-----------|----------|----------|----------------------------------------------------|
| type      | string   | no       | Filter by place type: `home`, `work`, `restaurant`, `store`, `medical`, `school`, `gym`, `other` |
| tags      | string[] | no       | Filter by tags (AND logic)                         |
| query     | string   | no       | Free-text search across name, address, tags        |
| near      | object   | no       | `{ lat: number, lon: number, radius_km: number }` for geo search |
| limit     | number   | no       | Max results. Default: 50. Max: 200.                |
| offset    | number   | no       | Pagination offset. Default: 0.                     |

**Returns:**

```json
{
  "places": [
    {
      "id": "string",
      "user_id": "string",
      "name": "string",
      "type": "string",
      "address": "string | null",
      "geo": {
        "lat": "number",
        "lon": "number"
      } | null,
      "tags": "string[]",
      "notes": "string | null",
      "created_at": "string (ISO 8601)",
      "updated_at": "string (ISO 8601)"
    }
  ],
  "total": "number"
}
```

#### get_place

Retrieve a single place by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Place ID    |

**Returns:**

```json
{
  "place": { "...place object" }
}
```

#### upsert_place

Create or update a place.

| Parameter | Type     | Required        | Description                                          |
|-----------|----------|-----------------|------------------------------------------------------|
| id        | string   | no              | Place ID to update. Omit to create new.              |
| name      | string   | yes (on create) | Place name                                           |
| type      | string   | yes (on create) | `home`, `work`, `restaurant`, `store`, `medical`, `school`, `gym`, `other` |
| address   | string   | no              | Full address text                                    |
| geo       | object   | no              | `{ lat: number, lon: number }`                       |
| tags      | string[] | no              | Tags for categorization                              |
| notes     | string   | no              | Free-text notes                                      |

**Returns:**

```json
{
  "place": { "...place object" },
  "created": "boolean"
}
```

#### delete_place

Delete a place by ID.

| Parameter | Type   | Required | Description |
|-----------|--------|----------|-------------|
| id        | string | yes      | Place ID    |

**Returns:**

```json
{
  "deleted": true
}
```

---

### Data Gaps

#### list_data_gaps

List known gaps in the knowledge base -- things the system wants to learn about the user.

| Parameter | Type   | Required | Description                                       |
|-----------|--------|----------|---------------------------------------------------|
| status    | string | no       | Filter by status: `open`, `answered`, `dismissed`. Default: `open`. |
| min_priority | number | no   | Minimum priority (1-10). Default: 1.              |
| limit     | number | no       | Max results. Default: 50.                         |
| offset    | number | no       | Pagination offset. Default: 0.                    |

**Returns:**

```json
{
  "data_gaps": [
    {
      "id": "string",
      "user_id": "string",
      "question": "string",
      "priority": "number (1-10)",
      "status": "open | answered | dismissed",
      "context": "string | null (why we want to know this)",
      "answer": "string | null (when status=answered)",
      "created_at": "string (ISO 8601)",
      "updated_at": "string (ISO 8601)"
    }
  ],
  "total": "number"
}
```

#### upsert_data_gap

Create or update a data gap.

| Parameter | Type   | Required        | Description                                  |
|-----------|--------|-----------------|----------------------------------------------|
| id        | string | no              | Data gap ID to update. Omit to create new.   |
| question  | string | yes (on create) | The question representing the knowledge gap  |
| priority  | number | yes (on create) | Priority 1-10 (10 = most important)          |
| status    | string | no              | `open`, `answered`, `dismissed`. Default: `open`. |
| context   | string | no              | Why this gap matters                         |
| answer    | string | no              | The answer, when resolving the gap           |

**Returns:**

```json
{
  "data_gap": { "...data_gap object" },
  "created": "boolean"
}
```

---

## Storage

### Elasticsearch Indices

| Index                        | Purpose                    | Key Mappings                                                      |
|------------------------------|----------------------------|-------------------------------------------------------------------|
| `ll5_knowledge_profile`      | One doc per user           | `user_id` (keyword), `name` (text), `timezone` (keyword), `location` (text), `bio` (text), `birth_date` (date), `languages` (keyword[]) |
| `ll5_knowledge_facts`        | User facts                 | `user_id` (keyword), `type` (keyword), `category` (keyword), `content` (text, analyzed for Hebrew+English), `provenance` (keyword), `confidence` (float), `tags` (keyword[]), `source` (text), `valid_from` (date), `valid_until` (date) |
| `ll5_knowledge_people`       | People in user's network   | `user_id` (keyword), `name` (text), `aliases` (text[]), `relationship` (keyword), `contact_info` (object), `tags` (keyword[]), `notes` (text) |
| `ll5_knowledge_places`       | Places relevant to user    | `user_id` (keyword), `name` (text), `type` (keyword), `address` (text), `geo` (geo_point), `tags` (keyword[]), `notes` (text) |
| `ll5_knowledge_data_gaps`    | Knowledge gaps to fill     | `user_id` (keyword), `question` (text), `priority` (integer), `status` (keyword), `context` (text), `answer` (text) |

### Index Settings

- All text fields use a custom analyzer with ICU tokenizer for Hebrew+English support.
- Fuzzy matching enabled on `content`, `name`, `aliases`, `question` fields via `fuzziness: "AUTO"`.
- All indices have `number_of_shards: 1`, `number_of_replicas: 1` (adjust for scale).

### Document ID Strategy

- Profile: document `_id` = `user_id` (one doc per user).
- All other entities: document `_id` = generated UUID, stored also as `id` field.

---

## Repository Interfaces

```typescript
interface PaginationParams {
  limit?: number;
  offset?: number;
}

interface PaginatedResult<T> {
  items: T[];
  total: number;
}

interface ProfileRepository {
  get(userId: string): Promise<Profile | null>;
  upsert(userId: string, data: Partial<ProfileData>): Promise<Profile>;
}

interface FactRepository {
  list(userId: string, filters: FactFilters & PaginationParams): Promise<PaginatedResult<Fact>>;
  get(userId: string, id: string): Promise<Fact | null>;
  upsert(userId: string, data: UpsertFactInput): Promise<{ fact: Fact; created: boolean }>;
  delete(userId: string, id: string): Promise<void>;
  search(userId: string, query: string, options?: FactSearchOptions): Promise<SearchResult<Fact>[]>;
}

interface PersonRepository {
  list(userId: string, filters: PersonFilters & PaginationParams): Promise<PaginatedResult<Person>>;
  get(userId: string, id: string): Promise<Person | null>;
  upsert(userId: string, data: UpsertPersonInput): Promise<{ person: Person; created: boolean }>;
  delete(userId: string, id: string): Promise<void>;
  search(userId: string, query: string, options?: PersonSearchOptions): Promise<SearchResult<Person>[]>;
}

interface PlaceRepository {
  list(userId: string, filters: PlaceFilters & PaginationParams): Promise<PaginatedResult<Place>>;
  get(userId: string, id: string): Promise<Place | null>;
  upsert(userId: string, data: UpsertPlaceInput): Promise<{ place: Place; created: boolean }>;
  delete(userId: string, id: string): Promise<void>;
  search(userId: string, query: string, options?: PlaceSearchOptions): Promise<SearchResult<Place>[]>;
  searchNear(userId: string, lat: number, lon: number, radiusKm: number, options?: PlaceFilters & PaginationParams): Promise<PaginatedResult<Place>>;
}

interface DataGapRepository {
  list(userId: string, filters: DataGapFilters & PaginationParams): Promise<PaginatedResult<DataGap>>;
  upsert(userId: string, data: UpsertDataGapInput): Promise<{ dataGap: DataGap; created: boolean }>;
}
```

### Filter Types

```typescript
interface FactFilters {
  type?: FactType;
  category?: string;
  tags?: string[];
  provenance?: Provenance;
  minConfidence?: number;
  query?: string;
}

interface PersonFilters {
  relationship?: string;
  tags?: string[];
  query?: string;
}

interface PlaceFilters {
  type?: PlaceType;
  tags?: string[];
  query?: string;
  near?: { lat: number; lon: number; radiusKm: number };
}

interface DataGapFilters {
  status?: DataGapStatus;
  minPriority?: number;
}
```

---

## Multi-Tenancy

- **Document-level isolation:** Every document in every index has a `user_id` keyword field.
- **Query-level enforcement:** Every Elasticsearch query includes a `term` filter on `user_id`. This is enforced at the repository layer -- no raw ES calls outside repositories.
- **Repository contract:** Every repository method takes `userId` as its first parameter. There is no method that operates without a user scope.
- **Index strategy:** Shared indices across users (not per-user indices) for operational simplicity. Isolation is purely query-based.
- **Validation:** The MCP server extracts `userId` from the authenticated session and passes it to every repository call. Tools never accept `userId` as a parameter from the caller.
