# MCP: awareness

**Domain:** Real-world context -- GPS locations, IM notifications from phone, entity statuses (what people are up to), calendar events, situational snapshots.

**Storage:** Elasticsearch (time-series data, geo queries, full-text search)

**Transport:** HTTP + SSE (remote deployment)

---

## Purpose

The system's eyes and ears. Receives processed push data from the Gateway (phone sends GPS pings, IM notifications, calendar events) and stores it in time-series Elasticsearch indices. Provides tools to query location history, IM messages, entity statuses, and a composite "situation" snapshot that summarizes the user's current context. Also tracks notable events for proactive checks so the agent can surface time-sensitive information without being asked.

This MCP is **read-heavy** -- it ingests data via gateway pushes and exposes query tools to the agent. The only write operation exposed to the agent is `acknowledge_events`.

---

## Elasticsearch Indices

| Index | Purpose | Key Fields |
|---|---|---|
| `ll5_awareness_locations` | GPS fix history | userId, timestamp, lat, lon, accuracy, place_name, place_type |
| `ll5_awareness_messages` | IM notifications captured from phone | userId, timestamp, sender, app, content, conversation_id, is_group |
| `ll5_awareness_entity_statuses` | Extracted status of people from IM and other signals | userId, entity_name, status_text, location, source, updated_at |
| `ll5_awareness_calendar_events` | Calendar events from push sources | userId, title, start, end, location, source, calendar_name, all_day |
| `ll5_awareness_notable_events` | Events flagged for proactive surfacing | userId, event_type, summary, severity, payload, created_at, acknowledged_at |

All indices are prefixed with `ll5_awareness_` and use `userId` as a required filter on every query (multi-tenancy).

---

## Tools

### get_current_location

Returns the most recent GPS fix for the user, enriched with reverse-geocoded place name and a freshness indicator.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `lat` | `number` | Latitude |
| `lon` | `number` | Longitude |
| `accuracy` | `number` | GPS accuracy in meters |
| `timestamp` | `string (ISO 8601)` | Time of GPS fix |
| `freshness` | `string` | `"live"` (< 5 min), `"recent"` (< 30 min), `"stale"` (< 2 hr), `"unknown"` (> 2 hr) |
| `place_name` | `string \| null` | Matched place name (e.g., "Home", "Office", "Dizengoff Center") |
| `place_type` | `string \| null` | Place category (e.g., "home", "work", "restaurant", "gym") |
| `address` | `string \| null` | Reverse-geocoded street address |

---

### query_location_history

Queries GPS history over a time range, with optional place filter. Returns a list of reverse-geocoded location points, deduplicated by significant movement.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `from` | `string (ISO 8601)` | yes | Start of time range |
| `to` | `string (ISO 8601)` | yes | End of time range |
| `place_filter` | `string` | no | Filter by place name (fuzzy match) |
| `place_type_filter` | `string` | no | Filter by place type (exact match) |
| `limit` | `number` | no | Max results (default: 100) |

**Returns:**

Array of location points:

| Field | Type | Description |
|---|---|---|
| `lat` | `number` | Latitude |
| `lon` | `number` | Longitude |
| `accuracy` | `number` | GPS accuracy in meters |
| `timestamp` | `string (ISO 8601)` | Time of GPS fix |
| `place_name` | `string \| null` | Matched place name |
| `place_type` | `string \| null` | Place category |
| `address` | `string \| null` | Reverse-geocoded street address |
| `duration_minutes` | `number \| null` | How long the user stayed at this point (if determinable) |

---

### query_im_messages

Queries IM notifications by sender, app, time range, and keyword. Supports full-text fuzzy search on message content via Elasticsearch.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `from` | `string (ISO 8601)` | no | Start of time range (default: 24h ago) |
| `to` | `string (ISO 8601)` | no | End of time range (default: now) |
| `sender` | `string` | no | Filter by sender name (fuzzy match) |
| `app` | `string` | no | Filter by app: `"whatsapp"`, `"telegram"`, `"signal"`, etc. |
| `keyword` | `string` | no | Full-text fuzzy search on message content |
| `conversation_id` | `string` | no | Filter by specific conversation |
| `is_group` | `boolean` | no | Filter to group or 1:1 messages only |
| `limit` | `number` | no | Max results (default: 50) |

**Returns:**

Array of messages:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Message document ID |
| `timestamp` | `string (ISO 8601)` | When the notification was received |
| `sender` | `string` | Sender display name |
| `app` | `string` | Source app identifier |
| `content` | `string` | Message text |
| `conversation_id` | `string` | Conversation identifier |
| `conversation_name` | `string \| null` | Group name or contact name |
| `is_group` | `boolean` | Whether this is a group message |
| `relevance_score` | `number \| null` | Elasticsearch relevance score (present when keyword search is used) |

---

### get_entity_statuses

Returns the latest known status of people, extracted from IM messages and other signals. Useful for knowing what contacts are up to, where they are, or their current state.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `entity_name` | `string` | no | Filter by person name (fuzzy match). If omitted, returns all recently updated entities. |
| `since` | `string (ISO 8601)` | no | Only return statuses updated after this time (default: 24h ago) |
| `limit` | `number` | no | Max results (default: 20) |

**Returns:**

Array of entity statuses:

| Field | Type | Description |
|---|---|---|
| `entity_name` | `string` | Person's display name |
| `status_text` | `string` | Free-text status summary (e.g., "stuck in traffic on Ayalon", "at the gym") |
| `location` | `string \| null` | Where they are, if known |
| `source` | `string` | How this was derived (e.g., "whatsapp message", "telegram message") |
| `source_message_id` | `string \| null` | Reference to the source IM message |
| `updated_at` | `string (ISO 8601)` | When this status was last updated |

---

### get_calendar_events

Returns calendar events for the user, merged from all push-based calendar sources. Google Calendar events fetched by the agent via the google MCP can also be cached here.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `from` | `string (ISO 8601)` | no | Start of range (default: start of today) |
| `to` | `string (ISO 8601)` | no | End of range (default: end of today) |
| `calendar_name` | `string` | no | Filter by calendar name |
| `include_all_day` | `boolean` | no | Include all-day events (default: true) |

**Returns:**

Array of calendar events:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Event document ID |
| `title` | `string` | Event title |
| `start` | `string (ISO 8601)` | Event start time |
| `end` | `string (ISO 8601)` | Event end time |
| `location` | `string \| null` | Event location |
| `description` | `string \| null` | Event description/notes |
| `calendar_name` | `string` | Source calendar name |
| `source` | `string` | Origin (e.g., "google", "apple", "push") |
| `all_day` | `boolean` | Whether this is an all-day event |
| `attendees` | `string[]` | List of attendee names/emails |

---

### get_situation

Returns a composite snapshot of the user's current situation. This is the primary tool for the agent to quickly understand context before responding.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `current_time` | `string (ISO 8601)` | Current server time |
| `timezone` | `string` | User's timezone (e.g., "Asia/Jerusalem") |
| `time_period` | `string` | `"morning"` (6-12), `"afternoon"` (12-17), `"evening"` (17-21), `"night"` (21-6) |
| `day_type` | `string` | `"weekday"` or `"weekend"` |
| `current_location` | `object \| null` | Same shape as `get_current_location` return value |
| `next_event` | `object \| null` | Next upcoming calendar event with `title`, `start`, `location` |
| `time_until_next_event` | `string \| null` | Human-readable duration (e.g., "in 45 minutes") |
| `suggested_energy` | `string` | `"low"`, `"medium"`, `"high"` -- heuristic based on time of day and schedule density |
| `notable_recent_events` | `object[]` | Unacknowledged notable events (same shape as `get_notable_events` return) |
| `active_conversations` | `number` | Count of IM conversations with messages in the last hour |

---

### get_notable_events

Returns unacknowledged notable events since a given timestamp. Used by proactive checks to determine if the agent should alert the user.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `since` | `string (ISO 8601)` | no | Only return events created after this time (default: 1h ago) |
| `event_type` | `string` | no | Filter by type: `"place_arrival"`, `"urgent_im"`, `"calendar_soon"`, `"entity_status_change"` |
| `min_severity` | `string` | no | Minimum severity: `"low"`, `"medium"`, `"high"` (default: `"low"`) |

**Returns:**

Array of notable events:

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Event document ID |
| `event_type` | `string` | Type of notable event |
| `summary` | `string` | Human-readable summary |
| `severity` | `string` | `"low"`, `"medium"`, `"high"` |
| `payload` | `object` | Type-specific payload (e.g., place details for arrival, message for urgent IM) |
| `created_at` | `string (ISO 8601)` | When the event was detected |
| `acknowledged_at` | `string (ISO 8601) \| null` | When acknowledged, or null |

---

### acknowledge_events

Marks notable events as acknowledged so they are no longer surfaced by `get_notable_events` or `get_situation`.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `event_ids` | `string[]` | yes | Array of notable event document IDs to acknowledge |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `acknowledged_count` | `number` | Number of events successfully acknowledged |

---

## Repository Interfaces

```typescript
interface LocationRecord {
  lat: number;
  lon: number;
  accuracy: number;
  timestamp: string;
  place_name: string | null;
  place_type: string | null;
  address: string | null;
  duration_minutes: number | null;
}

interface LocationRepository {
  /** Store a new GPS fix. */
  store(userId: string, location: Omit<LocationRecord, 'duration_minutes'>): Promise<void>;

  /** Get the most recent GPS fix. */
  getLatest(userId: string): Promise<LocationRecord | null>;

  /** Query location history within a time range. */
  query(
    userId: string,
    params: {
      from: string;
      to: string;
      place_filter?: string;
      place_type_filter?: string;
      limit?: number;
    }
  ): Promise<LocationRecord[]>;
}
```

```typescript
interface MessageRecord {
  id: string;
  timestamp: string;
  sender: string;
  app: string;
  content: string;
  conversation_id: string;
  conversation_name: string | null;
  is_group: boolean;
}

interface MessageSearchResult extends MessageRecord {
  relevance_score: number | null;
}

interface MessageRepository {
  /** Store a new IM notification. */
  store(userId: string, message: Omit<MessageRecord, 'id'>): Promise<string>;

  /** Full-text search over messages with filters. */
  query(
    userId: string,
    params: {
      from?: string;
      to?: string;
      sender?: string;
      app?: string;
      keyword?: string;
      conversation_id?: string;
      is_group?: boolean;
      limit?: number;
    }
  ): Promise<MessageSearchResult[]>;
}
```

```typescript
interface EntityStatusRecord {
  entity_name: string;
  status_text: string;
  location: string | null;
  source: string;
  source_message_id: string | null;
  updated_at: string;
}

interface EntityStatusRepository {
  /** Upsert an entity status (insert or update if entity_name matches). */
  upsert(userId: string, status: EntityStatusRecord): Promise<void>;

  /** Get status for a specific entity (fuzzy name match). */
  getByName(userId: string, entity_name: string): Promise<EntityStatusRecord | null>;

  /** List recently updated entity statuses. */
  listRecent(
    userId: string,
    params: {
      since?: string;
      limit?: number;
    }
  ): Promise<EntityStatusRecord[]>;
}
```

```typescript
interface CalendarEventRecord {
  id: string;
  title: string;
  start: string;
  end: string;
  location: string | null;
  description: string | null;
  calendar_name: string;
  source: string;
  all_day: boolean;
  attendees: string[];
}

interface CalendarEventRepository {
  /** Store or update a calendar event. Upserts by source + external event ID. */
  upsert(userId: string, event: CalendarEventRecord): Promise<void>;

  /** Query events within a time range. */
  query(
    userId: string,
    params: {
      from?: string;
      to?: string;
      calendar_name?: string;
      include_all_day?: boolean;
    }
  ): Promise<CalendarEventRecord[]>;

  /** Get the next upcoming event from now. */
  getNext(userId: string): Promise<CalendarEventRecord | null>;
}
```

```typescript
interface NotableEventRecord {
  id: string;
  event_type: 'place_arrival' | 'urgent_im' | 'calendar_soon' | 'entity_status_change';
  summary: string;
  severity: 'low' | 'medium' | 'high';
  payload: Record<string, unknown>;
  created_at: string;
  acknowledged_at: string | null;
}

interface NotableEventRepository {
  /** Create a new notable event. */
  create(userId: string, event: Omit<NotableEventRecord, 'id' | 'acknowledged_at'>): Promise<string>;

  /** Query unacknowledged notable events. */
  queryUnacknowledged(
    userId: string,
    params: {
      since?: string;
      event_type?: string;
      min_severity?: string;
    }
  ): Promise<NotableEventRecord[]>;

  /** Mark events as acknowledged. Returns count of events updated. */
  acknowledge(userId: string, eventIds: string[]): Promise<number>;
}
```
