-- 2026-07-04 — DECISION-022 tenant-scoping addendum.
--
-- userId → Vaultwarden tenant-org mapping for the vault MCP. The MCPs stay
-- stateless, so the mapping lives here in gateway PG and is served to the
-- vault MCP via GET /vault/tenant (self-scoped). The vault MCP resolves the
-- caller's org BEFORE every bw query and REFUSES when no row exists — this
-- table is the multi-tenancy boundary for credential access.
--
-- Rows are written ONLY through PUT /vault/tenant, which requires a
-- 'service'-role token (mintable only by AUTH_SECRET holders, i.e. the vault
-- MCP itself) — a user/agent token can never remap itself onto another
-- tenant's org.
--
-- status lifecycle: provisioning (row exists, org being created) → invited
-- (org + collection created, owner invite emailed) → active (membership
-- owner-confirmed; vault usable).
--
-- collection_id may be NULL for legacy rows — the vault MCP then resolves the
-- "agent" collection by name inside the org (still org-scoped).

CREATE TABLE IF NOT EXISTS vault_tenants (
  user_id       UUID PRIMARY KEY,
  org_id        TEXT NOT NULL,
  collection_id TEXT,
  status        TEXT NOT NULL DEFAULT 'provisioning'
                CHECK (status IN ('provisioning', 'invited', 'active')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the pre-tenancy setup created manually on 2026-07-04 (bootstrap.ts +
-- bw CLI): the admin user's org "LL5". Without this row the existing vault
-- would go dark the moment tenant scoping ships. Org name differs from the
-- new "LL5 <first8>" convention — harmless; the mapping is authoritative.
INSERT INTO vault_tenants (user_id, org_id, collection_id, status)
VALUES (
  'f08f46b3-0a9c-41ae-9e6a-294c697424e4',
  '3ef6bab6-0055-4cf3-96af-070dae7707e1',
  NULL,
  'active'
)
ON CONFLICT (user_id) DO NOTHING;
