-- 2026-07-12 — Multi-provider agent model config.
-- The old model was one provider + one key + one model + model_overrides
-- ({slot: model}). The redesign lets each slot pick its OWN provider + model,
-- backed by a key PER provider (zen / groq / anthropic), with a top-level
-- default that fills any unset slot. Stored as two JSONB columns on the existing
-- agent_llm_credentials row (no PK change, no data loss):
--
--   provider_keys : { "<provider>": { "ciphertext": "...", "last4": "...", "updated_at": "..." }, ... }
--   model_config  : { "default": {"provider","model"},
--                     "slots": { "main"|"grounder"|... : {"provider","model"} | null } }
--
-- The legacy provider/model/ciphertext/model_overrides columns are kept so
-- existing agents keep running; the GET path backfills provider_keys/model_config
-- from them on first read when the new columns are empty.
ALTER TABLE agent_llm_credentials
  ADD COLUMN IF NOT EXISTS provider_keys JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS model_config JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Keys now live per-provider in provider_keys; the single legacy `ciphertext`
-- column is no longer required (a row may hold only keys+config). Relax NOT NULL
-- so provider-key / model-config writes can create a row without the old column.
ALTER TABLE agent_llm_credentials ALTER COLUMN ciphertext DROP NOT NULL;
