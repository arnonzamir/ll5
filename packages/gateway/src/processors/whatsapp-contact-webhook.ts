import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

interface EvolutionContact {
  remoteJid: string;
  pushName?: string | null;
}

/**
 * Process CONTACTS_UPSERT / CONTACTS_UPDATE events from Evolution API.
 * Upserts contacts into messaging_contacts with pushName as display_name.
 */
export async function processWhatsAppContactWebhook(
  pgPool: Pool,
  userId: string,
  contacts: EvolutionContact[],
): Promise<void> {
  if (!contacts || contacts.length === 0) return;

  // Filter to contacts with valid pushName
  const valid = contacts.filter((c) => {
    if (!c.remoteJid || !c.pushName || c.pushName.trim() === '') return false;
    // Skip if pushName is just the phone number portion of the JID
    const phonePart = c.remoteJid.split('@')[0];
    if (c.pushName === phonePart) return false;
    // Skip group JIDs
    if (c.remoteJid.endsWith('@g.us')) return false;
    return true;
  });

  if (valid.length === 0) return;

  // Build batch INSERT...ON CONFLICT
  const values: unknown[] = [userId];
  const rows: string[] = [];
  let paramIndex = 2;

  for (const contact of valid) {
    const isLid = contact.remoteJid.endsWith('@lid');
    const phonePart = contact.remoteJid.split('@')[0];
    const phoneNumber = !isLid && /^\d+$/.test(phonePart) ? `+${phonePart}` : null;

    rows.push(
      `($1, 'whatsapp', $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, false, NOW())`,
    );
    values.push(contact.remoteJid, contact.pushName, phoneNumber);
    paramIndex += 3;
  }

  try {
    const result = await pgPool.query(
      `INSERT INTO messaging_contacts
         (user_id, platform, platform_id, display_name, phone_number, is_group, last_seen_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (user_id, platform, platform_id)
       DO UPDATE SET
         display_name = CASE
           WHEN messaging_contacts.display_name IS NULL
             OR messaging_contacts.display_name = ''
             OR messaging_contacts.display_name ~ '^\\+?[0-9]+$'
             OR messaging_contacts.display_name LIKE '%@s.whatsapp.net'
             OR messaging_contacts.display_name LIKE '%@lid'
           THEN EXCLUDED.display_name
           ELSE messaging_contacts.display_name
         END,
         phone_number = COALESCE(EXCLUDED.phone_number, messaging_contacts.phone_number),
         last_seen_at = NOW(),
         updated_at = NOW()
       RETURNING id`,
      values,
    );

    logger.info('[processWhatsAppContactWebhook] Contacts upserted', {
      received: contacts.length,
      valid: valid.length,
      affected: result.rows.length,
    });
  } catch (err) {
    logger.error('[processWhatsAppContactWebhook] Failed to upsert contacts', {
      error: err instanceof Error ? err.message : String(err),
      count: valid.length,
    });
  }
}
