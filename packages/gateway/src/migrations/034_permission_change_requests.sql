-- Human-approval gate for conversation AUTHORITY (contact_settings.permission).
--
-- The LL5 agent must NOT be able to change a conversation's permission directly.
-- The messaging MCP tools (update_conversation_permissions / set_contact_settings)
-- no longer write contact_settings.permission — instead they FILE a request here
-- (status='pending') and NOTIFY 'permission_approval'. The change is applied ONLY
-- by the phone/dashboard-authed POST /approvals/:id/decide endpoint, which is the
-- single code path allowed to write contact_settings.permission from a request.
--
-- user_id is text here (the request never needs the relational identity); the
-- approve path casts user_id::uuid for the contact_settings upsert.
CREATE TABLE IF NOT EXISTS permission_change_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  platform TEXT,
  conversation_id TEXT,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  display_name TEXT,
  current_permission TEXT,
  requested_permission TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_permission_change_requests_user_status
  ON permission_change_requests(user_id, status);
