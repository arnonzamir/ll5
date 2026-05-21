-- 2026-05-21
--
-- Idempotency for POST /chat/messages. The unify-conversations work introduces
-- Claude Code hooks (Stop / PostToolUse / UserPromptSubmit) that POST chat rows
-- automatically. Hooks can double-fire or be retried, and they coexist with the
-- agent's explicit reply()/push_to_user() calls — so a logical message must
-- never produce two rows. Callers pass a stable `idempotency_key`; the partial
-- unique index makes a duplicate INSERT a no-op (handled via ON CONFLICT in the
-- gateway), and the existing row is returned as success.
--
-- Nullable + partial index: legacy/manual posts that omit the key are unaffected
-- (NULLs are not deduped), so this is fully backward-compatible.

ALTER TABLE chat_messages
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_idempotency
  ON chat_messages (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
