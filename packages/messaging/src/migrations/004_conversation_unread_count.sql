-- Add unread_count to conversations (populated from Evolution API sync)
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS unread_count INTEGER DEFAULT 0;
