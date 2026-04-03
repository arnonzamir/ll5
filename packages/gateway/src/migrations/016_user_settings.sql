-- Unified user settings (JSONB). Replaces user_notification_settings and google_user_settings.
-- Structure: { timezone, notification: { max_level, quiet_max_level, quiet_start, quiet_end } }
CREATE TABLE IF NOT EXISTS user_settings (
  user_id    UUID PRIMARY KEY,
  settings   JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migrate existing notification settings if table exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'user_notification_settings') THEN
    INSERT INTO user_settings (user_id, settings, updated_at)
    SELECT
      user_id,
      jsonb_build_object(
        'timezone', timezone,
        'notification', jsonb_build_object(
          'max_level', max_level,
          'quiet_max_level', quiet_max_level,
          'quiet_start', to_char(quiet_start, 'HH24:MI'),
          'quiet_end', to_char(quiet_end, 'HH24:MI')
        )
      ),
      updated_at
    FROM user_notification_settings
    ON CONFLICT (user_id) DO UPDATE SET
      settings = user_settings.settings
        || jsonb_build_object('timezone', EXCLUDED.settings->>'timezone')
        || jsonb_build_object('notification', EXCLUDED.settings->'notification'),
      updated_at = now();
  END IF;
END $$;
