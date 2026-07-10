-- Per-agent/per-tool model overrides for a tenant's opencode runtime.
-- The `model` column is the MAIN agent model (default on everything); this map
-- lets specific sub-agents/tools (grounder, narrative consolidator, reconcile
-- worker) run on a different model. Keys are slot ids (see AGENT_MODEL_SLOTS in
-- gateway agent.ts); values are model ids from the provider catalog. Empty map =
-- every slot inherits the main model.
ALTER TABLE agent_llm_credentials
  ADD COLUMN IF NOT EXISTS model_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;
