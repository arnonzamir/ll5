-- 029: Superadmin role (BYO-agent tenant platform — tenant management).
--
-- Adds the 'superadmin' role tier above 'admin' for the tenant-management
-- console. Superadmin ⊇ admin: a superadmin passes every admin gate and may
-- additionally assign the 'admin'/'superadmin' roles and view enriched tenant
-- listings.
--
-- auth_users.role is free TEXT (migration 019: `role TEXT NOT NULL DEFAULT
-- 'user'`, no CHECK constraint). So there is nothing to widen — 'superadmin'
-- is already a storable value. We defensively drop any role CHECK constraint
-- that a future migration or manual change might have added, so this stays
-- correct even if the column gains a constraint elsewhere. Idempotent.

DO $$
DECLARE
  conname TEXT;
BEGIN
  -- Find a CHECK constraint on auth_users that references the role column and
  -- does NOT already allow 'superadmin'; drop it so the wider set is accepted.
  SELECT c.conname INTO conname
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'auth_users'
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) ILIKE '%role%'
    AND pg_get_constraintdef(c.oid) NOT ILIKE '%superadmin%'
  LIMIT 1;

  IF conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE auth_users DROP CONSTRAINT %I', conname);
  END IF;
END $$;

-- Promote the existing admin to superadmin. Idempotent (no-op if already set
-- or if the row is absent on a fresh DB).
UPDATE auth_users
   SET role = 'superadmin', updated_at = now()
 WHERE user_id = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4'
   AND role <> 'superadmin';
