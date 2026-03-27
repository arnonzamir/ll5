# MCP: google

**Domain:** Google Calendar and Gmail integration via OAuth2.

**Storage:** PostgreSQL (OAuth tokens encrypted at rest, calendar configuration)

**Transport:** HTTP + SSE (remote deployment)

---

## Purpose

Manages Google OAuth2 tokens and provides tools to read/write Google Calendar events and Gmail messages. Handles token refresh automatically -- when an access token expires, the MCP refreshes it using the stored refresh token before retrying the API call. Maintains a per-user calendar enable/disable config so the agent only sees events from calendars the user cares about.

This MCP is the only component that talks to Google APIs. Other MCPs (like awareness) may cache Google Calendar data received via push, but all direct Google API interactions go through this MCP.

---

## Database Tables

### google_oauth_tokens

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `varchar(255)` | User identifier (indexed, unique) |
| `access_token` | `text` | Encrypted OAuth2 access token |
| `refresh_token` | `text` | Encrypted OAuth2 refresh token |
| `token_type` | `varchar(50)` | Token type (typically "Bearer") |
| `expires_at` | `timestamptz` | Access token expiration time |
| `scopes` | `text[]` | Granted OAuth2 scopes |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last token refresh time |

### google_calendar_config

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `varchar(255)` | User identifier |
| `calendar_id` | `varchar(255)` | Google Calendar ID |
| `calendar_name` | `varchar(255)` | Display name |
| `enabled` | `boolean` | Whether to include in merged views (default: true) |
| `color` | `varchar(20)` | Calendar color hex code |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last update time |

Unique constraint on `(user_id, calendar_id)`.

---

## Tools

### get_auth_url

Returns an OAuth2 authorization URL that the user must visit to grant Google access. The URL includes the required scopes for Calendar and Gmail.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `scopes` | `string[]` | no | Requested scopes. Default: `["calendar.readonly", "calendar.events", "gmail.readonly", "gmail.send"]` |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `auth_url` | `string` | Full OAuth2 authorization URL for the user to visit |
| `state` | `string` | CSRF state token included in the URL |
| `requested_scopes` | `string[]` | Scopes that will be requested |

---

### handle_oauth_callback

Processes the OAuth2 callback after the user authorizes. Exchanges the authorization code for access and refresh tokens, encrypts them, and stores them.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `code` | `string` | yes | Authorization code from OAuth callback |
| `state` | `string` | yes | CSRF state token for validation |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether token exchange succeeded |
| `granted_scopes` | `string[]` | Scopes actually granted by the user |
| `email` | `string` | Google account email address |

---

### get_connection_status

Checks whether Google is connected for this user, whether the token is still valid, and what scopes were granted.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `connected` | `boolean` | Whether OAuth tokens exist for this user |
| `token_valid` | `boolean` | Whether the access token is currently valid (not expired) |
| `email` | `string \| null` | Google account email, if connected |
| `granted_scopes` | `string[]` | List of granted scopes |
| `expires_at` | `string (ISO 8601) \| null` | Token expiration time |
| `last_refreshed` | `string (ISO 8601) \| null` | Last time the token was refreshed |

---

### disconnect

Revokes the Google OAuth2 access token, deletes stored tokens and calendar config for the user.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether revocation and cleanup succeeded |
| `revoked` | `boolean` | Whether the token was successfully revoked at Google (may be false if token was already expired) |

---

### list_calendars

Lists all Google Calendars accessible to the user, including their enable/disable status in the local config. Syncs the calendar list from Google and merges with local config.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `refresh` | `boolean` | no | Force refresh from Google API (default: false, uses cached list) |

**Returns:**

Array of calendars:

| Field | Type | Description |
|---|---|---|
| `calendar_id` | `string` | Google Calendar ID |
| `name` | `string` | Calendar display name |
| `enabled` | `boolean` | Whether included in merged event views |
| `color` | `string` | Calendar color hex code |
| `access_role` | `string` | User's access role: `"owner"`, `"writer"`, `"reader"`, `"freeBusyReader"` |
| `primary` | `boolean` | Whether this is the user's primary calendar |

---

### list_events

Lists Google Calendar events within a date range. Returns a merged view from all enabled calendars (or a specific calendar if filtered).

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `from` | `string (ISO 8601)` | no | Start of date range (default: start of today) |
| `to` | `string (ISO 8601)` | no | End of date range (default: end of today) |
| `calendar_id` | `string` | no | Filter to a specific calendar. If omitted, merges all enabled calendars. |
| `query` | `string` | no | Free-text search query for event title/description |
| `max_results` | `number` | no | Max events to return (default: 50) |
| `include_all_day` | `boolean` | no | Include all-day events (default: true) |

**Returns:**

Array of events:

| Field | Type | Description |
|---|---|---|
| `event_id` | `string` | Google event ID |
| `calendar_id` | `string` | Which calendar this event belongs to |
| `calendar_name` | `string` | Calendar display name |
| `title` | `string` | Event title |
| `start` | `string (ISO 8601)` | Event start time |
| `end` | `string (ISO 8601)` | Event end time |
| `all_day` | `boolean` | Whether this is an all-day event |
| `location` | `string \| null` | Event location |
| `description` | `string \| null` | Event description |
| `attendees` | `object[]` | Array of `{ email: string, name: string \| null, response_status: string }` |
| `html_link` | `string` | Link to event in Google Calendar |
| `status` | `string` | `"confirmed"`, `"tentative"`, `"cancelled"` |
| `recurring` | `boolean` | Whether this is a recurring event instance |

---

### create_event

Creates a new event on a specified Google Calendar.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `calendar_id` | `string` | no | Target calendar ID (default: primary calendar) |
| `title` | `string` | yes | Event title |
| `start` | `string (ISO 8601)` | yes | Event start time |
| `end` | `string (ISO 8601)` | yes | Event end time |
| `description` | `string` | no | Event description |
| `location` | `string` | no | Event location |
| `attendees` | `string[]` | no | List of attendee email addresses |
| `all_day` | `boolean` | no | Create as all-day event (default: false). When true, `start` and `end` should be date strings (YYYY-MM-DD). |
| `reminders` | `object` | no | `{ use_default: boolean, overrides?: { method: "email" \| "popup", minutes: number }[] }` |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `event_id` | `string` | Created event's Google ID |
| `html_link` | `string` | Link to view the event in Google Calendar |
| `status` | `string` | Event status (typically `"confirmed"`) |

---

### list_emails

Lists Gmail messages matching a search query, with optional label and date filtering.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `query` | `string` | no | Gmail search query (same syntax as Gmail search bar, e.g., `"from:alice subject:meeting"`) |
| `label` | `string` | no | Filter by Gmail label (e.g., `"INBOX"`, `"SENT"`, `"STARRED"`) |
| `from` | `string (ISO 8601)` | no | Only messages after this date |
| `to` | `string (ISO 8601)` | no | Only messages before this date |
| `max_results` | `number` | no | Max messages to return (default: 20) |
| `include_body` | `boolean` | no | Include full message body (default: true). Set to false for headers-only listing. |

**Returns:**

Array of email messages:

| Field | Type | Description |
|---|---|---|
| `message_id` | `string` | Gmail message ID |
| `thread_id` | `string` | Gmail thread ID |
| `from` | `string` | Sender (formatted as `"Name <email>"`) |
| `to` | `string[]` | Recipients |
| `cc` | `string[]` | CC recipients |
| `subject` | `string` | Email subject |
| `date` | `string (ISO 8601)` | Sent date |
| `snippet` | `string` | Short preview text |
| `body` | `string \| null` | Full message body (plain text), null if `include_body` is false |
| `labels` | `string[]` | Gmail labels on this message |
| `is_unread` | `boolean` | Whether the message is unread |
| `has_attachments` | `boolean` | Whether the message has attachments |

---

### send_email

Sends an email via Gmail on behalf of the user.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `to` | `string[]` | yes | Recipient email addresses |
| `subject` | `string` | yes | Email subject line |
| `body` | `string` | yes | Email body (plain text) |
| `cc` | `string[]` | no | CC recipients |
| `bcc` | `string[]` | no | BCC recipients |
| `reply_to_message_id` | `string` | no | Gmail message ID to reply to (sets In-Reply-To header and thread) |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `message_id` | `string` | Sent message's Gmail ID |
| `thread_id` | `string` | Thread ID (new or existing if reply) |

---

## Repository Interfaces

```typescript
interface OAuthTokenRecord {
  user_id: string;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: Date;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

interface OAuthTokenRepository {
  /** Store tokens after initial OAuth exchange. Encrypts tokens before storage. */
  store(userId: string, tokens: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_at: Date;
    scopes: string[];
  }): Promise<void>;

  /** Get decrypted tokens for a user. Returns null if not connected. */
  get(userId: string): Promise<OAuthTokenRecord | null>;

  /** Update tokens after a refresh. Encrypts the new access token. */
  updateAccessToken(userId: string, access_token: string, expires_at: Date): Promise<void>;

  /** Delete all tokens for a user. */
  delete(userId: string): Promise<void>;
}
```

```typescript
interface CalendarConfigRecord {
  user_id: string;
  calendar_id: string;
  calendar_name: string;
  enabled: boolean;
  color: string;
  created_at: Date;
  updated_at: Date;
}

interface CalendarConfigRepository {
  /** Upsert calendar config. Used when syncing calendar list from Google. */
  upsert(userId: string, config: {
    calendar_id: string;
    calendar_name: string;
    color: string;
  }): Promise<void>;

  /** List all calendar configs for a user. */
  list(userId: string): Promise<CalendarConfigRecord[]>;

  /** Update enabled status for a calendar. */
  setEnabled(userId: string, calendar_id: string, enabled: boolean): Promise<void>;

  /** Get only enabled calendar IDs. */
  getEnabledCalendarIds(userId: string): Promise<string[]>;

  /** Delete all calendar configs for a user. Used during disconnect. */
  deleteAll(userId: string): Promise<void>;
}
```
