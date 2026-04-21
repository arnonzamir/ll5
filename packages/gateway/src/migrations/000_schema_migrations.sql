-- Migration ledger. Before this file, the gateway's runMigrations() replayed
-- every .sql on every boot, which meant every migration had to be idempotent
-- forever. Migration 021 slipped that discipline (ADD CONSTRAINT had no guard)
-- and crash-looped the gateway on Apr 21.
--
-- With the ledger: runMigrations() records each file it applies and skips
-- those already present. New migrations can stop worrying about "what if this
-- runs twice" — they run exactly once per database.
--
-- File sorts as 000_* so it runs before everything else.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
