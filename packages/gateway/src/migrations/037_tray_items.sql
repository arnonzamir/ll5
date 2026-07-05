-- 2026-07-05 — Agent-filed tray items (generic decision cards).
--
-- The 4th "Needs You" source: rows the AGENT files when a decision genuinely
-- needs the user (weekly-review decisions, plan choices — anything with 2-3
-- clear options). The agent posts via POST /tray-items (chatAuth — its channel
-- holds a user token); the phone reads them through the EXISTING GET /me/tray
-- contract as kind="decision" cards (spec §3 / §6b: A/B/C chips, agent's
-- recommendation pre-highlighted) and answers via POST /me/tray/decision.
--
-- `options` is a jsonb array of 2-3 {key, label, recommended?} entries.
-- `default_key` names the option applied on expiry (interaction model §3:
-- "cards expire with the agent's default applied AND disclosed"). The
-- TrayItemExpiry sweep only flips status + notifies the agent — the AGENT
-- applies the default action itself.

CREATE TABLE IF NOT EXISTS tray_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'decision',
  question    TEXT NOT NULL,
  context     TEXT,
  options     JSONB NOT NULL,          -- [{key:"a",label,recommended:bool}] 2-3 entries
  default_key TEXT,
  expires_at  TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'expired')),
  answer_key  TEXT,
  answered_at TIMESTAMPTZ,
  source      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The tray reads open rows per user on every GET /me/tray; the expiry sweep
-- scans open rows past their deadline.
CREATE INDEX IF NOT EXISTS idx_tray_items_user_open
  ON tray_items (user_id, status)
  WHERE status = 'open';
