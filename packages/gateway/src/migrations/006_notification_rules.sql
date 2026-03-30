CREATE TABLE IF NOT EXISTS notification_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  rule_type TEXT NOT NULL CHECK (rule_type IN ('sender', 'app', 'keyword', 'group', 'app_direct')),
  match_value TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'immediate' CHECK (priority IN ('immediate', 'batch')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notification_rules_user ON notification_rules(user_id);
