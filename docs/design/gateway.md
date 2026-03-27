# Gateway

A thin HTTP service that receives push data from the user's phone and writes to the awareness MCP's Elasticsearch indices.

## Purpose

The phone (via Tasker on Android or Shortcuts on iOS) periodically pushes GPS locations, IM notification captures, and calendar events to the gateway. The gateway processes and stores them.

The gateway is **not an MCP** -- it is infrastructure. It sits between the phone and Elasticsearch, handling authentication, geocoding, entity resolution, and document writes. Claude Code never calls the gateway directly; it reads the resulting data through the awareness MCP.

## Endpoints

### POST /webhook/:token

Receive push data from the phone. The `:token` path parameter authenticates the user.

**Request body:** JSON array of items, each with a `type`, `timestamp`, and type-specific fields.

**Response:** `200 OK` with `{ "accepted": <count> }` on success, `401 Unauthorized` for invalid token, `400 Bad Request` for malformed payloads.

### GET /health

Returns `200 OK` with `{ "status": "ok" }`. Used by Coolify and uptime monitors.

## Webhook Payload Schema

The request body is a JSON object with a single `items` array:

```json
{
  "items": [
    {
      "type": "location",
      "timestamp": "2026-03-27T10:30:00Z",
      "lat": 13.7563,
      "lon": 100.5018,
      "accuracy_m": 15,
      "battery_pct": 72
    },
    {
      "type": "message",
      "timestamp": "2026-03-27T10:32:00Z",
      "sender": "Alice Chen",
      "app": "whatsapp",
      "body": "Are we still meeting at 3?",
      "is_group": false,
      "group_name": null
    },
    {
      "type": "calendar_event",
      "timestamp": "2026-03-27T10:35:00Z",
      "title": "Dentist appointment",
      "start": "2026-03-28T14:00:00+07:00",
      "end": "2026-03-28T15:00:00+07:00",
      "location": "Smile Dental Clinic",
      "all_day": false
    }
  ]
}
```

### Field Reference

**All items:**

| Field       | Type   | Required | Description                        |
|-------------|--------|----------|------------------------------------|
| type        | string | yes      | `location`, `message`, or `calendar_event` |
| timestamp   | string | yes      | ISO 8601 UTC timestamp of capture  |

**Location items:**

| Field        | Type   | Required | Description                    |
|--------------|--------|----------|--------------------------------|
| lat          | number | yes      | Latitude (WGS84)              |
| lon          | number | yes      | Longitude (WGS84)             |
| accuracy_m   | number | no       | GPS accuracy in meters         |
| battery_pct  | number | no       | Battery percentage at capture  |

**Message items:**

| Field      | Type    | Required | Description                       |
|------------|---------|----------|-----------------------------------|
| sender     | string  | yes      | Display name of the sender        |
| app        | string  | yes      | Source app (whatsapp, telegram, etc.) |
| body       | string  | yes      | Message text content              |
| is_group   | boolean | no       | Whether message is from a group chat |
| group_name | string  | no       | Group name if is_group is true    |

**Calendar event items:**

| Field    | Type    | Required | Description                        |
|----------|---------|----------|------------------------------------|
| title    | string  | yes      | Event title                        |
| start    | string  | yes      | ISO 8601 start time with timezone  |
| end      | string  | yes      | ISO 8601 end time with timezone    |
| location | string  | no       | Event location text                |
| all_day  | boolean | no       | Whether this is an all-day event   |

## Processing Pipeline

Each item type follows a different processing path after validation.

### Location Items

```
location item
  |
  +--> reverse geocode (Nominatim or Google Geocoding API)
  |      produces: address, neighborhood, city, country
  |
  +--> query ES ll5_knowledge_places index
  |      geo_distance query, 100m radius around (lat, lon)
  |      if match found: attach place_id, place_name
  |
  +--> write to ll5_awareness_locations
  |      { user_id, timestamp, lat, lon, accuracy_m, address, place_id?, place_name?, battery_pct }
  |
  +--> if place match found:
         write to ll5_awareness_notable_events
         { user_id, timestamp, event_type: "arrived_at_place", place_id, place_name }
```

### Message Items

```
message item
  |
  +--> write to ll5_awareness_messages
  |      { user_id, timestamp, sender, app, body, is_group, group_name }
  |
  +--> extract entity name from sender field
  |
  +--> query ES ll5_knowledge_people index
  |      match on name/aliases
  |
  +--> if known person found:
         write/update ll5_awareness_entity_statuses
         { user_id, entity_id, entity_name, last_message_at, last_app, status: "recent_contact" }
```

### Calendar Event Items

```
calendar_event item
  |
  +--> write to ll5_awareness_calendar_events
         { user_id, timestamp, title, start, end, location, all_day }
```

## Authentication

### Current (Single User)

A single webhook token is configured via environment variable `WEBHOOK_TOKEN`. It maps to the hardcoded `user_id`.

```
WEBHOOK_TOKEN=abc123def456
USER_ID=550e8400-e29b-41d4-a716-446655440000
```

### Multi-User

Tokens are stored in a PostgreSQL table owned by the gateway:

```sql
CREATE TABLE webhook_tokens (
    token       TEXT PRIMARY KEY,
    user_id     UUID NOT NULL,
    label       TEXT,            -- e.g. "arnon-pixel8", "arnon-ipad"
    created_at  TIMESTAMPTZ DEFAULT now(),
    revoked_at  TIMESTAMPTZ
);
```

The gateway gets its own small PostgreSQL connection (separate from any MCP databases). Token lookup is cached in-memory with a short TTL (60s).

### Token Lifecycle

- Tokens are generated server-side (UUIDv4 or similar random string).
- One user can have multiple tokens (one per device).
- Revocation sets `revoked_at`; the gateway rejects revoked tokens.
- No token rotation for v1. Add rotation in v2 if needed.

## Tech Stack

- **Runtime:** Node.js
- **Framework:** Fastify (lightweight, schema validation built in)
- **Elasticsearch:** `@elastic/elasticsearch` client for document writes and geo queries
- **HTTP client:** `undici` (bundled with Node) for geocoding API calls
- **Deployment:** Docker container on Coolify
- **Size:** ~50-100 lines of core logic, plus schema definitions and config

## Configuration

Environment variables:

| Variable              | Description                              | Example                    |
|-----------------------|------------------------------------------|----------------------------|
| PORT                  | HTTP listen port                         | 3100                       |
| WEBHOOK_TOKEN         | Single-user webhook token                | abc123def456               |
| USER_ID               | Single-user UUID                         | 550e8400-...               |
| ELASTICSEARCH_URL     | ES connection URL                        | http://elasticsearch:9200  |
| GEOCODING_PROVIDER    | `nominatim` or `google`                  | nominatim                  |
| GEOCODING_API_KEY     | API key (required for google provider)   | AIza...                    |
| DATABASE_URL          | PostgreSQL URL (multi-user only)         | postgres://...             |

## Error Handling

- Invalid token: `401`, no processing.
- Malformed payload: `400` with validation errors.
- Geocoding API failure: log warning, store location without address. Do not fail the request.
- ES write failure: `500`, log error with full context. Phone will retry on next push cycle.
- Individual item failures do not block other items in the same batch. Response includes per-item status if any fail.
