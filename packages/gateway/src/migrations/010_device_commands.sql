CREATE TABLE IF NOT EXISTS device_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  command_type TEXT NOT NULL, -- 'create_event', 'update_event', 'delete_event'
  payload JSONB NOT NULL, -- command-specific data
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'confirmed', 'failed', 'expired')),
  fcm_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_device_commands_user_status ON device_commands(user_id, status);
