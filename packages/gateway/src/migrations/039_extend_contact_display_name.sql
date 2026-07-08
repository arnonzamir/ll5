-- Extend messaging_contacts.display_name to handle longer contact names from phone
-- Previously VARCHAR(255), causing failures when syncing contacts with long names
ALTER TABLE messaging_contacts ALTER COLUMN display_name TYPE text;
