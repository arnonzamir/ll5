-- Add archived status for WhatsApp conversations
ALTER TABLE messaging_conversations ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;
