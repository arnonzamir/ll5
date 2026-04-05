# Unified Contact & Routing System

## Problem

Three separate systems control messaging behavior, spread across three UI pages:
1. `notification_rules` — routing priority (ignore/batch/immediate/agent), matches by name substring (ambiguous)
2. `messaging_conversations.permission` — reply permission (ignore/input/agent)
3. `notification_rules.download_images` — per-conversation photo download toggle

Name-based matching is broken: "אריאל" matches all Ariels. Need stable identity-based control.

## Design: One System, Two Entity Types

### People (1:1 messages)
A real person identified by their stable `ll5_knowledge_people` ES ID. Controls how the agent handles their **direct/1:1 messages only**. If they message in a group, the group's settings apply.

Settings per person:
- **Routing**: ignore / batch / immediate / agent
- **Permission**: ignore / input / agent (can the agent reply to their 1:1 messages)
- **Photos**: download / skip

### Groups (group conversations)
A group chat identified by its `messaging_conversations` conversation_id. Controls all messages in that group, regardless of sender.

Settings per group:
- **Routing**: ignore / batch / immediate / agent
- **Permission**: ignore / input / agent
- **Photos**: download / skip

### Keywords (cross-cutting)
Keyword rules remain — they trigger across any message regardless of person or group. Keep existing behavior.

## Resolution Logic

```
Is it a group message?
  → Look up conversation rule for that group_id
  → Use group's routing/permission/photos settings
  → Fall through to keyword → wildcard if no group rule

Is it a 1:1 message?
  → Resolve sender to person_id via platform_id (messaging_contacts)
  → Look up person rule for that person_id
  → Use person's routing/permission/photos settings
  → Fall through to keyword → wildcard if no person rule

No match?
  → Keyword rules → app rules → wildcard
```

**Key**: person rules NEVER apply in groups. Groups are self-contained.

## Data Model

### Replace `notification_rules` + `messaging_conversations.permission` + `download_images`

New table: `contact_settings`

```sql
CREATE TABLE contact_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,

  -- What this rule targets
  target_type VARCHAR(20) NOT NULL,  -- 'person' or 'group'
  target_id VARCHAR(255) NOT NULL,   -- person ES ID or conversation_id

  -- Settings
  routing VARCHAR(20) NOT NULL DEFAULT 'batch',      -- ignore/batch/immediate/agent
  permission VARCHAR(20) NOT NULL DEFAULT 'input',    -- ignore/input/agent
  download_media BOOLEAN NOT NULL DEFAULT false,

  -- Display (cached for UI)
  display_name VARCHAR(255),
  platform VARCHAR(20),              -- for groups: whatsapp/telegram/slack

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(user_id, target_type, target_id)
);
```

### Keep `notification_rules` for keywords/app/wildcard only

Existing keyword, app, and wildcard rules stay in `notification_rules`. Only sender/group/conversation rules migrate to `contact_settings`.

### `messaging_contacts` — unchanged

Still links platform_id → person_id. The resolution layer.

## Matcher Changes

```typescript
async match(userId, message): Priority {
  // 0. Active escalation check
  if (escalated) return 'immediate';

  // 1. Group message → look up group settings
  if (message.is_group && message.conversation_id) {
    const groupSettings = await getContactSettings(userId, 'group', message.conversation_id);
    if (groupSettings) return groupSettings.routing;
  }

  // 2. 1:1 message → resolve person, look up person settings
  if (!message.is_group && message.person_id) {
    const personSettings = await getContactSettings(userId, 'person', message.person_id);
    if (personSettings) return personSettings.routing;
  }

  // 3. Keyword/app/wildcard (from notification_rules, unchanged)
  return matchLegacyRules(userId, message);
}
```

Permission and download_media are read from the same `contact_settings` row.

## Contact Resolution at Ingest

### WhatsApp webhook
```typescript
// Already have remoteJid
// For groups: conversation_id = remoteJid → look up contact_settings(target_type='group', target_id=remoteJid)
// For 1:1: look up messaging_contacts(platform='whatsapp', platform_id=remoteJid) → get person_id
//          → look up contact_settings(target_type='person', target_id=person_id)
```

### Phone IM (notification capture)
Best-effort name resolution against `messaging_contacts.display_name`. If ambiguous, skip person resolution.

## Unified UI: `/settings/contacts`

One page replacing `/settings/notifications`, `/settings/messaging`, and `/contacts`.

### Layout

**Tab: People**
| Person | Platforms | Routing | Permission | Media | Actions |
|--------|-----------|---------|------------|-------|---------|
| Ariel Zamir | WhatsApp, Telegram | `immediate` | `agent` | download | Edit |
| Mom | WhatsApp | `immediate` | `input` | download | Edit |
| (unlinked contacts) | WhatsApp: +972... | `batch` | `input` | skip | Link |

- Search + filter
- People with linked platform identities show all platforms
- Unlinked contacts appear at the bottom with a "Link to person" action
- Click person to edit settings
- Auto-match button to bulk-link contacts by phone/name

**Tab: Groups**
| Group | Platform | Routing | Permission | Media |
|-------|----------|---------|------------|-------|
| Family | WhatsApp | `immediate` | `agent` | download |
| דיונים ROI | WhatsApp | `batch` | `input` | skip |
| gtd_in | WhatsApp | `immediate` | `input` | download |

- Search + filter by platform
- Archived groups shown grayed out
- Click group to edit settings

**Tab: Keywords**
Existing keyword rules UI — unchanged.

## Migration Path

### Phase 1: Create `contact_settings` table
- Migrate existing `conversation` rules from `notification_rules` → `contact_settings(target_type='group')`
- Migrate `sender` rules where a person_id can be resolved → `contact_settings(target_type='person')`
- Migrate `messaging_conversations.permission` → `contact_settings.permission`
- Migrate `download_images` → `contact_settings.download_media`

### Phase 2: Update matcher
- New matcher reads from `contact_settings` for person/group lookups
- Legacy keyword/app/wildcard rules stay in `notification_rules`
- Old `sender`/`conversation` rules in `notification_rules` deprecated

### Phase 3: UI
- Build unified `/settings/contacts` page
- Remove `/settings/notifications` (redirect to new page)
- Remove `/settings/messaging` (redirect to new page)
- Remove `/contacts` (merge into new page)

### Phase 4: Cleanup
- Drop deprecated rule types from `notification_rules`
- Remove old UI pages

## Implementation Files

### New
- `packages/gateway/src/migrations/017_contact_settings.sql`
- `packages/dashboard/src/app/(user)/settings/contacts/` — unified page

### Modified
- `packages/gateway/src/processors/notification-rules.ts` — matcher reads `contact_settings`
- `packages/gateway/src/processors/whatsapp-webhook.ts` — resolve person_id, pass to matcher
- `packages/gateway/src/processors/message.ts` — resolve person_id for phone IMs
- `packages/gateway/src/server.ts` — CRUD endpoints for `contact_settings`
- `packages/awareness/src/setup/indices.ts` — add `person_id` to message index

### Removed (after migration)
- `packages/dashboard/src/app/(user)/settings/notifications/`
- `packages/dashboard/src/app/(user)/settings/messaging/`
- `packages/dashboard/src/app/(user)/contacts/`
