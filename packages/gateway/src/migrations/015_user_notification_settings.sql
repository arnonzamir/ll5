-- User notification level settings: controls how aggressively the phone grabs attention
-- Levels: silent (shade+badge), notify (sound/soft vibe), alert (sound+vibe+heads-up), critical (override DND)
CREATE TABLE IF NOT EXISTS user_notification_settings (
  user_id        UUID PRIMARY KEY,
  max_level      VARCHAR(20) NOT NULL DEFAULT 'critical',
  quiet_max_level VARCHAR(20) NOT NULL DEFAULT 'silent',
  quiet_start    TIME NOT NULL DEFAULT '23:00',
  quiet_end      TIME NOT NULL DEFAULT '07:00',
  timezone       VARCHAR(100) NOT NULL DEFAULT 'Asia/Jerusalem',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
