-- Per-conversation image download setting
ALTER TABLE notification_rules ADD COLUMN IF NOT EXISTS download_images BOOLEAN DEFAULT false;
