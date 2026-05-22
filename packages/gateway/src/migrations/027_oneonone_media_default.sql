-- 027: 1:1 conversations include pictures by default.
--
-- The resolver now defaults per-person (1:1) download_media to ON. Bring existing
-- per-person contact_settings rows in line: they were created with the column
-- default (false) — either by the dashboard before this policy or by the 026
-- sender-rule migration (which only set routing) — and no person row was ever
-- explicitly turned ON. Flip them so existing direct chats also include pictures.
-- Group defaults are unchanged (groups stay opt-in).
UPDATE contact_settings
SET download_media = true, updated_at = now()
WHERE target_type = 'person' AND download_media = false;
