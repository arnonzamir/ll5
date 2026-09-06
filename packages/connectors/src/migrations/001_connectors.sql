-- Connectors MCP — Phase 0 schema (docs/design/connectors.md, Section 3).
-- Every table carries user_id; every repository query is scoped by it from the
-- request context. Payloads are AES-256-GCM ciphertext (application-level,
-- @ll5/shared encrypt/decrypt); only what rules and reconciliation need stays
-- in plaintext columns (amount, currency, time, HMAC merchant key).

-- Per-user connector state (one row per catalog entry the user has touched).
CREATE TABLE IF NOT EXISTS connectors (
  user_id              VARCHAR(255) NOT NULL,
  connector_id         VARCHAR(50)  NOT NULL,
  enabled              BOOLEAN      NOT NULL DEFAULT false,
  status               TEXT         NOT NULL DEFAULT 'unconfigured',  -- unconfigured|ok|auth_failed|error|stale
  schedule_minutes     INTEGER,
  last_success_at      TIMESTAMPTZ,
  last_error_at        TIMESTAMPTZ,
  last_error           TEXT,
  consecutive_failures INTEGER      NOT NULL DEFAULT 0,
  cursor               JSONB,
  config               JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector_id)
);

-- Secrets live apart so listing never touches them (health precedent).
CREATE TABLE IF NOT EXISTS connector_credentials (
  user_id      VARCHAR(255) NOT NULL,
  connector_id VARCHAR(50)  NOT NULL,
  auth_type    TEXT         NOT NULL,
  secret_enc   TEXT         NOT NULL,
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, connector_id)
);

-- Near-real-time feed (phone notifications / webhooks), inserted by the gateway
-- through POST /api/events. Idempotent on (user_id, dedupe_key).
CREATE TABLE IF NOT EXISTS connector_events (
  id             UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        VARCHAR(255)  NOT NULL,
  connector_id   VARCHAR(50)   NOT NULL,
  kind           TEXT          NOT NULL,             -- charge|refund|bill|appointment|notice|state_change|otp|unknown
  occurred_at    TIMESTAMPTZ   NOT NULL,
  received_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  amount         NUMERIC(14,2),
  currency       CHAR(3),
  is_foreign     BOOLEAN       NOT NULL DEFAULT false,
  account_ref    TEXT,
  merchant_key   TEXT,                               -- HMAC-SHA256(normalized merchant, service sub-key)
  dedupe_key     TEXT          NOT NULL,
  payload_enc    TEXT,                               -- nulled after 90 days (retention step in sync)
  rule_hits      TEXT[]        NOT NULL DEFAULT '{}',
  matched_row_id UUID,
  status         TEXT          NOT NULL DEFAULT 'open', -- open|matched|expired
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS connector_events_user_occurred_idx
  ON connector_events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS connector_events_user_connector_status_idx
  ON connector_events (user_id, connector_id, status);

-- Batch feed (adapter pulls, skill-driven ingest_ledger_rows). Upsert on external_id.
CREATE TABLE IF NOT EXISTS connector_ledger_rows (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(255)  NOT NULL,
  connector_id VARCHAR(50)   NOT NULL,
  account_ref  TEXT,
  external_id  TEXT          NOT NULL,
  kind         TEXT          NOT NULL,
  occurred_at  TIMESTAMPTZ   NOT NULL,
  posted_at    TIMESTAMPTZ,
  amount       NUMERIC(14,2),
  currency     CHAR(3),
  merchant_key TEXT,
  payload_enc  TEXT,                                 -- merchant, memo, category, installments, source JSON
  fetched_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (user_id, connector_id, external_id)
);
CREATE INDEX IF NOT EXISTS connector_ledger_rows_user_occurred_idx
  ON connector_ledger_rows (user_id, occurred_at DESC);

-- What the reconciler / sync could not explain. Summaries carry no merchant text.
CREATE TABLE IF NOT EXISTS connector_findings (
  id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      VARCHAR(255)  NOT NULL,
  connector_id VARCHAR(50)   NOT NULL,
  kind         TEXT          NOT NULL,               -- unmatched_event|missing_event|stale_feed|auth_failed|rule_hit
  summary      TEXT          NOT NULL,
  ref_id       UUID,                                 -- the event / ledger row this is about
  opened_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ,
  resolution   TEXT,
  delivered    TEXT          NOT NULL DEFAULT 'none' -- immediate|digest|none
);
CREATE INDEX IF NOT EXISTS connector_findings_user_open_idx
  ON connector_findings (user_id, connector_id) WHERE resolved_at IS NULL;
