# MCP: messaging

**Domain:** WhatsApp (via Evolution API) and Telegram (via Bot API) send/receive.

**Storage:** PostgreSQL (account configs, conversation metadata)

**Transport:** HTTP + SSE (remote deployment)

---

## Purpose

Enables the assistant to send messages on WhatsApp and Telegram, and to read recent messages from monitored conversations. Manages bot/account configurations and per-conversation permissions.

**Important distinction:** This MCP does NOT act as a chat channel for the user -- Claude Code is the user's direct channel. This MCP exists so the assistant can communicate with **other people** on the user's behalf (e.g., "tell Dan I'm running late") or read incoming messages from monitored conversations (e.g., "what did the family group say today").

Conversation permissions control what the agent can do with each conversation:
- **agent** -- the agent may read and send messages in this conversation
- **input** -- the agent may read messages (used as context/awareness) but not send
- **ignore** -- the agent ignores this conversation entirely

---

## Database Tables

### messaging_whatsapp_accounts

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `varchar(255)` | User identifier (indexed) |
| `instance_name` | `varchar(255)` | Evolution API instance name |
| `instance_id` | `varchar(255)` | Evolution API instance ID |
| `api_url` | `text` | Evolution API base URL |
| `api_key` | `text` | Encrypted Evolution API key |
| `phone_number` | `varchar(50)` | Connected WhatsApp phone number |
| `status` | `varchar(50)` | Connection status: `"connected"`, `"disconnected"`, `"qr_pending"` |
| `last_seen_at` | `timestamptz` | Last successful API health check |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last update time |

### messaging_telegram_accounts

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `varchar(255)` | User identifier (indexed) |
| `bot_token` | `text` | Encrypted Telegram Bot API token |
| `bot_username` | `varchar(255)` | Bot's @username |
| `bot_name` | `varchar(255)` | Bot display name |
| `status` | `varchar(50)` | Connection status: `"connected"`, `"disconnected"`, `"token_invalid"` |
| `last_seen_at` | `timestamptz` | Last successful API health check |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last update time |

### messaging_conversations

| Column | Type | Description |
|---|---|---|
| `id` | `uuid` | Primary key |
| `user_id` | `varchar(255)` | User identifier (indexed) |
| `account_id` | `uuid` | FK to whatsapp or telegram account |
| `platform` | `varchar(20)` | `"whatsapp"` or `"telegram"` |
| `conversation_id` | `varchar(255)` | Platform-specific conversation/chat ID |
| `name` | `varchar(255)` | Contact or group display name |
| `is_group` | `boolean` | Whether this is a group conversation |
| `permission` | `varchar(20)` | `"agent"`, `"input"`, or `"ignore"` (default: `"ignore"`) |
| `last_message_at` | `timestamptz` | Timestamp of most recent message |
| `created_at` | `timestamptz` | Row creation time |
| `updated_at` | `timestamptz` | Last update time |

Unique constraint on `(user_id, platform, conversation_id)`.

---

## Tools

### list_accounts

Lists all configured WhatsApp and Telegram accounts for the user, with current connection status.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `platform` | `string` | no | Filter by platform: `"whatsapp"` or `"telegram"`. If omitted, returns both. |

**Returns:**

Array of accounts:

| Field | Type | Description |
|---|---|---|
| `account_id` | `string` | Account UUID |
| `platform` | `string` | `"whatsapp"` or `"telegram"` |
| `display_name` | `string` | Phone number (WhatsApp) or bot username (Telegram) |
| `status` | `string` | `"connected"`, `"disconnected"`, `"qr_pending"`, `"token_invalid"` |
| `last_seen_at` | `string (ISO 8601) \| null` | Last successful health check |

---

### send_whatsapp

Sends a WhatsApp message to a contact or group via Evolution API.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `account_id` | `string` | yes | WhatsApp account UUID |
| `to` | `string` | yes | Recipient phone number (with country code, e.g., `"972501234567"`) or group JID |
| `message` | `string` | yes | Message text to send |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the message was accepted by the API |
| `message_id` | `string \| null` | Platform message ID if available |
| `timestamp` | `string (ISO 8601)` | When the message was sent |

**Errors:**

| Error | Description |
|---|---|
| `ACCOUNT_NOT_FOUND` | No WhatsApp account with this ID for the user |
| `ACCOUNT_DISCONNECTED` | Account is not currently connected |
| `PERMISSION_DENIED` | Conversation is not in `"agent"` mode |
| `SEND_FAILED` | Evolution API rejected the message |

---

### send_telegram

Sends a Telegram message to a chat via Bot API.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `account_id` | `string` | yes | Telegram account UUID |
| `chat_id` | `string` | yes | Telegram chat ID (user, group, or channel) |
| `message` | `string` | yes | Message text to send (supports Telegram MarkdownV2 formatting) |
| `parse_mode` | `string` | no | `"MarkdownV2"`, `"HTML"`, or `"plain"` (default: `"plain"`) |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the message was accepted by the API |
| `message_id` | `number \| null` | Telegram message ID if available |
| `timestamp` | `string (ISO 8601)` | When the message was sent |

**Errors:**

| Error | Description |
|---|---|
| `ACCOUNT_NOT_FOUND` | No Telegram account with this ID for the user |
| `ACCOUNT_DISCONNECTED` | Account is not currently connected / token invalid |
| `PERMISSION_DENIED` | Conversation is not in `"agent"` mode |
| `SEND_FAILED` | Telegram Bot API rejected the message |

---

### list_conversations

Lists monitored conversations across platforms, with their permission levels and last activity.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `platform` | `string` | no | Filter by platform: `"whatsapp"` or `"telegram"` |
| `permission` | `string` | no | Filter by permission: `"agent"`, `"input"`, `"ignore"` |
| `account_id` | `string` | no | Filter by specific account |
| `is_group` | `boolean` | no | Filter to groups or 1:1 conversations only |
| `limit` | `number` | no | Max results (default: 50) |

**Returns:**

Array of conversations:

| Field | Type | Description |
|---|---|---|
| `conversation_id` | `string` | Platform-specific conversation ID |
| `account_id` | `string` | Account UUID this conversation belongs to |
| `platform` | `string` | `"whatsapp"` or `"telegram"` |
| `name` | `string` | Contact or group display name |
| `is_group` | `boolean` | Whether this is a group conversation |
| `permission` | `string` | Current permission level: `"agent"`, `"input"`, `"ignore"` |
| `last_message_at` | `string (ISO 8601) \| null` | Timestamp of most recent message |

---

### update_conversation_permissions

Sets the permission mode for a conversation, controlling what the agent can do.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `platform` | `string` | yes | `"whatsapp"` or `"telegram"` |
| `conversation_id` | `string` | yes | Platform-specific conversation ID |
| `permission` | `string` | yes | New permission: `"agent"`, `"input"`, or `"ignore"` |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `success` | `boolean` | Whether the update succeeded |
| `previous_permission` | `string` | The permission level before the change |
| `new_permission` | `string` | The permission level after the change |

---

### read_messages

Reads recent messages from a conversation. Respects permission levels -- only works for conversations in `"agent"` or `"input"` mode.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `platform` | `string` | yes | `"whatsapp"` or `"telegram"` |
| `conversation_id` | `string` | yes | Platform-specific conversation ID |
| `limit` | `number` | no | Max messages to return (default: 20) |
| `since` | `string (ISO 8601)` | no | Only return messages after this timestamp |

**Returns:**

Array of messages:

| Field | Type | Description |
|---|---|---|
| `message_id` | `string` | Platform message ID |
| `timestamp` | `string (ISO 8601)` | When the message was sent |
| `sender_name` | `string` | Sender display name |
| `sender_id` | `string` | Sender's platform-specific ID |
| `content` | `string` | Message text content |
| `is_from_bot` | `boolean` | Whether this message was sent by the bot/agent |
| `is_group` | `boolean` | Whether this is from a group conversation |
| `reply_to_message_id` | `string \| null` | ID of the message being replied to, if any |

**Errors:**

| Error | Description |
|---|---|
| `CONVERSATION_NOT_FOUND` | No conversation with this ID |
| `PERMISSION_DENIED` | Conversation is in `"ignore"` mode |
| `ACCOUNT_DISCONNECTED` | The associated account is not connected |

---

### sync_whatsapp_conversations

Refreshes the conversation list from WhatsApp via Evolution API. Discovers new conversations and updates names. Existing permission settings are preserved.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `account_id` | `string` | yes | WhatsApp account UUID to sync |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `total_conversations` | `number` | Total conversations after sync |
| `new_conversations` | `number` | Number of newly discovered conversations |
| `updated_conversations` | `number` | Number of conversations with updated metadata |

---

### get_account_status

Returns detailed connection health for a specific account, including last error if disconnected.

**Parameters:**

| Name | Type | Required | Description |
|---|---|---|---|
| `userId` | `string` | yes | User identifier |
| `account_id` | `string` | yes | Account UUID (WhatsApp or Telegram) |

**Returns:**

| Field | Type | Description |
|---|---|---|
| `account_id` | `string` | Account UUID |
| `platform` | `string` | `"whatsapp"` or `"telegram"` |
| `display_name` | `string` | Phone number or bot username |
| `status` | `string` | `"connected"`, `"disconnected"`, `"qr_pending"`, `"token_invalid"` |
| `last_seen_at` | `string (ISO 8601) \| null` | Last successful health check |
| `last_error` | `string \| null` | Last error message, if status is not `"connected"` |
| `uptime_seconds` | `number \| null` | Seconds since last reconnection, if connected |
| `message_count_today` | `number` | Messages sent via this account today |

---

## Repository Interfaces

```typescript
interface WhatsAppAccountRecord {
  id: string;
  user_id: string;
  instance_name: string;
  instance_id: string;
  api_url: string;
  api_key: string;
  phone_number: string;
  status: 'connected' | 'disconnected' | 'qr_pending';
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface TelegramAccountRecord {
  id: string;
  user_id: string;
  bot_token: string;
  bot_username: string;
  bot_name: string;
  status: 'connected' | 'disconnected' | 'token_invalid';
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AccountRepository {
  /** List WhatsApp accounts for a user. */
  listWhatsApp(userId: string): Promise<WhatsAppAccountRecord[]>;

  /** List Telegram accounts for a user. */
  listTelegram(userId: string): Promise<TelegramAccountRecord[]>;

  /** Get a WhatsApp account by ID. Decrypts the API key. */
  getWhatsApp(userId: string, accountId: string): Promise<WhatsAppAccountRecord | null>;

  /** Get a Telegram account by ID. Decrypts the bot token. */
  getTelegram(userId: string, accountId: string): Promise<TelegramAccountRecord | null>;

  /** Update account connection status. */
  updateStatus(
    userId: string,
    accountId: string,
    status: string,
    lastError?: string
  ): Promise<void>;
}
```

```typescript
interface ConversationRecord {
  id: string;
  user_id: string;
  account_id: string;
  platform: 'whatsapp' | 'telegram';
  conversation_id: string;
  name: string;
  is_group: boolean;
  permission: 'agent' | 'input' | 'ignore';
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ConversationRepository {
  /** List conversations with optional filters. */
  list(
    userId: string,
    params?: {
      platform?: string;
      permission?: string;
      account_id?: string;
      is_group?: boolean;
      limit?: number;
    }
  ): Promise<ConversationRecord[]>;

  /** Get a specific conversation. */
  get(
    userId: string,
    platform: string,
    conversationId: string
  ): Promise<ConversationRecord | null>;

  /** Upsert a conversation (used during sync). Preserves existing permission if record exists. */
  upsert(
    userId: string,
    conversation: {
      account_id: string;
      platform: string;
      conversation_id: string;
      name: string;
      is_group: boolean;
    }
  ): Promise<{ created: boolean }>;

  /** Update permission for a conversation. Returns previous permission. */
  updatePermission(
    userId: string,
    platform: string,
    conversationId: string,
    permission: 'agent' | 'input' | 'ignore'
  ): Promise<{ previous_permission: string }>;

  /** Update last_message_at timestamp. */
  touchLastMessage(
    userId: string,
    platform: string,
    conversationId: string,
    timestamp: Date
  ): Promise<void>;
}
```
