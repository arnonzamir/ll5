# Unified Contact Identity

## Problem

Routing rules match by display name substring ("אריאל" matches all Ariels across all conversations). A person can appear as "Ariel", "אריאל", "Ariel Z" across platforms. Need stable identity-based routing.

## Key Insight: Infrastructure Already Exists

- `ll5_knowledge_people` (ES) — the Person record IS the unified contact ID
- `messaging_contacts` (PG) — already has `person_id` FK linking platform IDs to people
- Dashboard `/contacts` page — already has link/unlink UI
- MCP tools: `link_contact_to_person`, `resolve_contact`, `auto_match_contacts`

## Three Gaps to Fill

### Gap 1: `person` Rule Type

Add `person` to `notification_rules.rule_type`. For person rules, `match_value` is the Person ES ID. Matches across all platforms.

Priority order in matcher:
```
0. Escalation check (existing)
1. Conversation-specific rules (existing)
2. Person rules — NEW: if person_id provided, match rule_type='person'
3. Pattern-based rules (existing sender/app/keyword/group)
4. Wildcard (existing)
```

### Gap 2: Contact Resolution at Ingest

When a WhatsApp message arrives:
1. Extract `remoteJid` (existing)
2. **New**: `SELECT person_id FROM messaging_contacts WHERE platform='whatsapp' AND platform_id=$1`
3. Pass `person_id` to `matcher.match()`

For phone-pushed IMs (no platform_id): best-effort name match against `messaging_contacts.display_name`.

### Gap 3: `person_id` on Messages

Add `person_id` and `contact_id` fields to `ll5_awareness_messages` and `ll5_awareness_entity_statuses`. Enables:
- Message history by person (across name variations)
- Entity status dedup by person (not by name string)

## Implementation Steps

### Step 1: Migration
```sql
-- Add 'person' to rule_type CHECK constraint
ALTER TABLE notification_rules DROP CONSTRAINT IF EXISTS notification_rules_rule_type_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_rule_type_check
  CHECK (rule_type IN ('sender','app','app_direct','app_group','keyword','group','wildcard','conversation','person'));
```

### Step 2: Gateway Contact Resolution
In `whatsapp-webhook.ts`, after extracting remoteJid:
```typescript
let personId: string | null = null;
const contactResult = await pgPool.query(
  'SELECT person_id FROM messaging_contacts WHERE platform=$1 AND platform_id=$2 AND person_id IS NOT NULL LIMIT 1',
  ['whatsapp', remoteJid],
);
personId = contactResult.rows[0]?.person_id ?? null;
```
Pass `personId` to `matcher.match()`.

### Step 3: Matcher Update
In `NotificationRuleMatcher.match()`:
- Add `person_id?: string` to message parameter
- Between conversation and pattern rules: check `rule_type='person'` where `match_value === person_id`

### Step 4: ES Message Enrichment
Add `person_id` to the ES document in `whatsapp-webhook.ts` and `message.ts`.

### Step 5: Entity Status Dedup
When `person_id` is available, use it for the deterministic entity status ID instead of sender name.

### Step 6: Phone IM Resolution
Best-effort: query `messaging_contacts` by `display_name ILIKE` for phone-pushed messages.

### Step 7: Update Tool Enums
Add `person` to `create_notification_rule` tool's `rule_type` enum.

### Step 8: Dashboard
- Contacts page: "Create routing rule" button for linked contacts
- Notification settings: show person name for `person` rules, warn when `sender` rules are ambiguous

## Migration Path

- Phase 1: Add `person` rule type. Existing `sender` rules unchanged.
- Phase 2: Agent gradually replaces ambiguous `sender` rules with `person` rules.
- Phase 3: Dashboard suggests converting ambiguous sender rules.

## Group Handling

Groups continue using `conversation` rules (already exact by conversation_id). Groups are not people — no change needed.

## No New Tables

Everything builds on existing `ll5_knowledge_people` + `messaging_contacts` + `notification_rules`.
