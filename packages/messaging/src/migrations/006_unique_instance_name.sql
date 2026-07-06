-- Make the WhatsApp instance→user mapping AUTHORITATIVE at the DB layer.
--
-- The whole inbound pipeline attributes a webhook to a tenant via
-- `SELECT user_id FROM messaging_whatsapp_accounts WHERE instance_name = $1 LIMIT 1`
-- (gateway whatsapp-user-resolver). That trusts instance_name to be globally
-- unique, but nothing enforced it — and create_whatsapp_account accepts a
-- caller-supplied instance_name. Two rows sharing an instance_name (across
-- tenants) would make attribution non-deterministic → cross-tenant message
-- leak/hijack (DECISION-024 tenant audit, GAP 1). Evolution already enforces
-- global instance-name uniqueness, so a real collision can't run; this makes the
-- invariant the pipeline assumes true at the database too.
--
-- Idempotent: guard so re-running on every boot is safe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messaging_wa_instance_name_unique'
  ) THEN
    -- Pre-clean any pre-existing duplicate instance_name rows so ADD CONSTRAINT
    -- can't hard-fail (and block the MCP's boot migrations). Keep the most-recent
    -- row per instance_name; a real duplicate here means an orphaned/ghost row.
    DELETE FROM messaging_whatsapp_accounts a
     USING messaging_whatsapp_accounts b
     WHERE a.instance_name = b.instance_name
       AND a.created_at < b.created_at;

    ALTER TABLE messaging_whatsapp_accounts
      ADD CONSTRAINT messaging_wa_instance_name_unique UNIQUE (instance_name);
  END IF;
END $$;
