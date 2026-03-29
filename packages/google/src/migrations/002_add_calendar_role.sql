-- Add role column to google_calendar_config for distinguishing tickler calendar
ALTER TABLE google_calendar_config ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user';
