-- Unified contact settings: replaces sender/conversation notification_rules + messaging_conversations.permission + download_images
-- target_type: 'person' (1:1 messages by person ES ID) or 'group' (group chat by conversation_id)
CREATE TABLE IF NOT EXISTS contact_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  target_type VARCHAR(20) NOT NULL CHECK (target_type IN ('person', 'group')),
  target_id VARCHAR(255) NOT NULL,
  routing VARCHAR(20) NOT NULL DEFAULT 'batch' CHECK (routing IN ('ignore', 'batch', 'immediate', 'agent')),
  permission VARCHAR(20) NOT NULL DEFAULT 'input' CHECK (permission IN ('ignore', 'input', 'agent')),
  download_media BOOLEAN NOT NULL DEFAULT false,
  display_name VARCHAR(255),
  platform VARCHAR(20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_settings_user ON contact_settings(user_id, target_type);

-- Migrate existing conversation rules from notification_rules
INSERT INTO contact_settings (user_id, target_type, target_id, routing, download_media, platform)
SELECT
  user_id,
  'group',
  match_value,
  priority,
  COALESCE(download_images, false),
  platform
FROM notification_rules
WHERE rule_type = 'conversation'
ON CONFLICT (user_id, target_type, target_id) DO NOTHING;

-- Migrate conversation permissions from messaging_conversations
UPDATE contact_settings cs
SET permission = mc.permission,
    display_name = mc.name
FROM messaging_conversations mc
WHERE cs.target_type = 'group'
  AND cs.target_id = mc.conversation_id
  AND cs.user_id = mc.user_id;
