-- Unified message priority system: 4 levels (ignore, batch, immediate, agent)
-- Merges notification_rules and messaging_conversations.permission into one system

-- Add 'agent' priority
ALTER TABLE notification_rules DROP CONSTRAINT IF EXISTS notification_rules_priority_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_priority_check
  CHECK (priority IN ('immediate', 'batch', 'ignore', 'agent'));

-- Add 'conversation' rule type
ALTER TABLE notification_rules DROP CONSTRAINT IF EXISTS notification_rules_rule_type_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_rule_type_check
  CHECK (rule_type IN ('sender', 'app', 'keyword', 'group', 'app_direct', 'app_group', 'wildcard', 'conversation'));

-- Platform column for conversation rules
ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS platform TEXT;

-- Unique constraint: one rule per conversation per user
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_rules_conversation
  ON notification_rules (user_id, platform, match_value)
  WHERE rule_type = 'conversation';

-- Migrate existing conversation permissions to notification rules
INSERT INTO notification_rules (user_id, rule_type, match_value, priority, platform)
SELECT
  mc.user_id::uuid, 'conversation', mc.conversation_id,
  CASE mc.permission
    WHEN 'agent' THEN 'agent'
    WHEN 'input' THEN 'batch'
    WHEN 'ignore' THEN 'ignore'
  END,
  mc.platform
FROM messaging_conversations mc
WHERE mc.permission != 'ignore'
ON CONFLICT DO NOTHING;
