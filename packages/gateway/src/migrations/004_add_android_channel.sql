-- Add 'android' and 'system' to the channel check constraint
ALTER TABLE chat_messages DROP CONSTRAINT IF EXISTS chat_messages_channel_check;
ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_channel_check CHECK (channel IN ('web', 'telegram', 'whatsapp', 'cli', 'android', 'system'));
