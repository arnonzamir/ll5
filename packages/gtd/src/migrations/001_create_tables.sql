-- GTD MCP: Initial schema
-- All tables are idempotent (IF NOT EXISTS)

-- Unified horizons table (h=0 through h=5)
CREATE TABLE IF NOT EXISTS gtd_horizons (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  horizon         SMALLINT NOT NULL CHECK (horizon BETWEEN 0 AND 5),
  title           TEXT NOT NULL,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'completed', 'on_hold', 'dropped')),

  -- Action-specific (horizon 0)
  energy          TEXT CHECK (energy IN ('low', 'medium', 'high')),
  list_type       TEXT CHECK (list_type IN ('todo', 'shopping', 'waiting', 'someday')),
  context         JSONB DEFAULT '[]',
  due_date        DATE,
  start_date      DATE,
  project_id      UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
  area_id         UUID REFERENCES gtd_horizons(id) ON DELETE SET NULL,
  waiting_for     TEXT,
  time_estimate   INTEGER,
  category        TEXT,

  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for gtd_horizons
CREATE INDEX IF NOT EXISTS idx_horizons_user_status ON gtd_horizons(user_id, status);
CREATE INDEX IF NOT EXISTS idx_horizons_user_horizon ON gtd_horizons(user_id, horizon);
CREATE INDEX IF NOT EXISTS idx_horizons_project ON gtd_horizons(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_horizons_area ON gtd_horizons(area_id) WHERE area_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_horizons_due_date ON gtd_horizons(user_id, due_date) WHERE due_date IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_horizons_list_type ON gtd_horizons(user_id, list_type) WHERE horizon = 0;
CREATE INDEX IF NOT EXISTS idx_horizons_context ON gtd_horizons USING GIN(context) WHERE horizon = 0;

-- GTD inbox
CREATE TABLE IF NOT EXISTS gtd_inbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  content         TEXT NOT NULL,
  source          TEXT DEFAULT 'direct',
  source_link     TEXT,
  status          TEXT NOT NULL DEFAULT 'captured'
                    CHECK (status IN ('captured', 'reviewed', 'processed')),
  outcome_type    TEXT CHECK (outcome_type IN ('action', 'project', 'someday', 'reference', 'trash')),
  outcome_id      UUID,
  notes           TEXT,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for gtd_inbox
CREATE INDEX IF NOT EXISTS idx_inbox_user_status ON gtd_inbox(user_id, status);

-- Review session tracking
CREATE TABLE IF NOT EXISTS gtd_review_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT NOT NULL,
  review_type     TEXT NOT NULL CHECK (review_type IN ('daily', 'weekly', 'horizons')),
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed')),
  current_phase   TEXT,
  phase_data      JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);

-- Indexes for gtd_review_sessions
CREATE INDEX IF NOT EXISTS idx_reviews_user ON gtd_review_sessions(user_id, started_at DESC);
