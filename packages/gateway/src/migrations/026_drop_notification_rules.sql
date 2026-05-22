-- 026: Unify all per-contact / per-chat communication settings into contact_settings,
-- then retire the legacy notification_rules table.
--
-- contact_settings becomes the single source of truth for routing (Delivery),
-- permission (Authority) and download_media. The keyword-rule feature is removed
-- entirely; the dead rule types (app/app_direct/app_group/group/wildcard) are dropped
-- with the table.

-- Step A: (re)backfill conversation rules into contact_settings. Idempotent — 017 did this
-- once, but the messaging MCP kept writing notification_rules afterwards, so re-run to catch
-- any conversation rows added since.
INSERT INTO contact_settings (user_id, target_type, target_id, routing, download_media, platform)
SELECT
  user_id,
  'group',
  match_value,
  priority,
  COALESCE(download_images, false),
  platform
FROM notification_rules
WHERE rule_type = 'conversation'
ON CONFLICT (user_id, target_type, target_id) DO NOTHING;

-- Step B: best-effort migration of sender rules (keyed by a display-name string) into
-- per-person contact_settings. The name is resolved to a KB person_id via messaging_contacts.
-- Senders that don't resolve to a linked person (bots, Slack channel:author composites,
-- unknown names) are intentionally dropped — they cannot be expressed as a person row.
-- An existing contact_settings row for the same person wins (ON CONFLICT DO NOTHING).
INSERT INTO contact_settings (user_id, target_type, target_id, routing, display_name)
SELECT DISTINCT ON (nr.user_id, mc.person_id)
  nr.user_id,
  'person',
  mc.person_id,
  nr.priority,
  nr.match_value
FROM notification_rules nr
JOIN messaging_contacts mc
  ON mc.user_id::uuid = nr.user_id
  AND mc.is_group = false
  AND mc.person_id IS NOT NULL
  AND lower(mc.display_name) = lower(nr.match_value)
WHERE nr.rule_type = 'sender'
ORDER BY nr.user_id, mc.person_id, nr.created_at
ON CONFLICT (user_id, target_type, target_id) DO NOTHING;

-- Step C: retire the legacy table. All routing/permission/media now resolves from
-- contact_settings; keyword matching is removed as a feature.
DROP TABLE IF EXISTS notification_rules;
