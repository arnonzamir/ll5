-- Replace boolean enabled with access_mode: ignore, read, readwrite
ALTER TABLE google_calendar_config ADD COLUMN IF NOT EXISTS access_mode VARCHAR(20) DEFAULT 'read';

-- Migrate existing data: enabled=true → read, enabled=false → ignore
UPDATE google_calendar_config SET access_mode = CASE WHEN enabled = true THEN 'read' ELSE 'ignore' END WHERE access_mode IS NULL OR access_mode = 'read';

-- The enabled column is kept for backwards compatibility but access_mode is authoritative
