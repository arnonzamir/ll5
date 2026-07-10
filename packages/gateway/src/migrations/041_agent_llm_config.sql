-- 2026-07-10 — Per-tenant agent LLM config (provider / model / base_url).
--
-- agent_llm_credentials was key-only and Claude-oriented (a single encrypted
-- Anthropic key per user). Extend it so a tenant can choose the provider
-- (anthropic | opencode), the model, and an optional base_url (opencode server
-- / provider base). The orchestrator reads these to build each user's agent
-- env-file; the trigger path reads `model` to select the per-tenant model.
--
-- Defaults keep existing Claude rows valid: provider='anthropic', model NULL
-- (falls back to the image/env default).

ALTER TABLE agent_llm_credentials
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'anthropic',
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS base_url TEXT;
