-- Add app_group and wildcard rule types
ALTER TABLE notification_rules DROP CONSTRAINT IF EXISTS notification_rules_rule_type_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_rule_type_check
  CHECK (rule_type IN ('sender', 'app', 'keyword', 'group', 'app_direct', 'app_group', 'wildcard'));
