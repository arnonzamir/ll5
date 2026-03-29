# MCP: google

**Domain:** Google Calendar, Gmail, and Tickler system via OAuth2.

**Storage:** PostgreSQL (OAuth tokens encrypted at rest, calendar configuration with role)

**Transport:** HTTP + SSE (remote deployment)

---

## Purpose

Manages Google OAuth2 tokens and provides tools to read/write Google Calendar events, manage a tickler calendar (LL5 System), and access Gmail. Handles token refresh automatically -- when an access token expires, the MCP refreshes it using the stored refresh token before retrying the API call. Maintains a per-user calendar enable/disable config so the agent only sees events from calendars the user cares about.

This MCP is the only component that talks to Google APIs. Other MCPs (like awareness) may cache Google Calendar data received via push, but all direct Google API interactions go through this MCP.

The tickler calendar ("LL5 System") is a dedicated Google Calendar for temporal nudges — things Claude should remind the user about at a certain time. These are not meetings/appointments but GTD-style tickler items (e.g., "start planning X", "medication running out").

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

### create_tickler

Creates a temporal nudge on the LL5 System calendar. Auto-creates the calendar on first use.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `title` | `string` | yes | What to be reminded about |
| `due_date` | `string (YYYY-MM-DD)` | yes | When this should surface |
| `due_time` | `string (HH:MM)` | no | Specific time (24h). If omitted, creates all-day event. |
| `description` | `string` | no | Additional context |
| `category` | `string` | no | Category: health, admin, planning, financial, social, errands |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `event_id` | `string` | Created tickler event ID |
| `title` | `string` | Full title (with category prefix if set) |
| `due_date` | `string` | Due date |
| `due_time` | `string` | Due time or "all-day" |

---

### list_ticklers

Lists upcoming tickler reminders from the LL5 System calendar.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `from` | `string (ISO 8601)` | no | Start of range (default: today) |
| `to` | `string (ISO 8601)` | no | End of range (default: 7 days) |
| `include_past` | `boolean` | no | Include past ticklers (default: false) |

**Returns:**

Array of tickler events with `event_id`, `title`, `start`, `end`, `all_day`, `description`, `status`.

---

### complete_tickler

Marks a tickler as done by deleting it from the LL5 System calendar.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `event_id` | `string` | yes | The event ID of the tickler to complete |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether deletion succeeded |

---

## REST API Endpoints

These endpoints are for internal use by the gateway (calendar sync and periodic review). Same auth as the MCP endpoint.

### GET /api/events

Returns calendar events across all enabled calendars.

Query params: `from`, `to`, `calendar_id` (all optional, defaults to today).

### GET /api/ticklers

Returns tickler calendar events.

Query params: `from`, `to` (optional, defaults to today through 7 days).

### GET /oauth/callback

OAuth2 redirect endpoint (no auth required). Handles the code exchange automatically and renders a success page.

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
  role: string; // 'user' or 'tickler'
  created_at: Date;
  updated_at: Date;
}

interface CalendarConfigRepository {
  /** Upsert calendar config. Used when syncing calendar list from Google. */
  upsert(userId: string, config: {
    calendar_id: string;
    calendar_name: string;
    color: string;
    role?: string;
  }): Promise<void>;

  /** List all calendar configs for a user. */
  list(userId: string): Promise<CalendarConfigRecord[]>;

  /** Get calendar config by role (e.g., 'tickler'). */
  getByRole(userId: string, role: string): Promise<CalendarConfigRecord | null>;

  /** Update enabled status for a calendar. */
  setEnabled(userId: string, calendar_id: string, enabled: boolean): Promise<void>;

  /** Get only enabled calendar IDs. */
  getEnabledCalendarIds(userId: string): Promise<string[]>;

  /** Delete all calendar configs for a user. Used during disconnect. */
  deleteAll(userId: string): Promise<void>;
}
```
