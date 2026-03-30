-- Add 'ignore' as a valid priority level for notification rules
ALTER TABLE notification_rules DROP CONSTRAINT IF EXISTS notification_rules_priority_check;
ALTER TABLE notification_rules ADD CONSTRAINT notification_rules_priority_check
  CHECK (priority IN ('immediate', 'batch', 'ignore'));
