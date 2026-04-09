import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

/**
 * Normalize a phone number for matching against WhatsApp JIDs.
 * Strips +, spaces, dashes, parens — keeps digits only.
 * Also tries common country code variants for Israeli numbers.
 */
function normalizePhone(raw: string): string[] {
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return [];

  const variants = new Set<string>();
  variants.add(digits);

  // If starts with country code (e.g. 972), also add without leading zero variant
  // 972544589555 → already good
  // If starts with 0 (local format), add with 972 prefix
  if (digits.startsWith('0') && digits.length >= 9) {
    variants.add('972' + digits.slice(1));
  }
  // If starts with 972, also add the local 0-prefixed version
  if (digits.startsWith('972') && digits.length >= 12) {
    variants.add('0' + digits.slice(3));
  }

  return [...variants];
}

interface PhoneContactItem {
  sender: string; // display name
  body: string;   // phone number
}

/**
 * Process a batch of phone_contact items from Android address book push.
 * Matches by phone number against messaging_contacts and updates display_name
 * where the current name is null, empty, a phone number, or a WhatsApp JID.
 */
export async function processPhoneContacts(
  pgPool: Pool,
  userId: string,
  contacts: PhoneContactItem[],
): Promise<number> {
  let enriched = 0;

  for (const contact of contacts) {
    const name = contact.sender?.trim();
    const phone = contact.body?.trim();
    if (!name || !phone) continue;

    const variants = normalizePhone(phone);
    if (variants.length === 0) continue;

    // Build JID patterns to match: digits@s.whatsapp.net and digits@lid
    const jidPatterns: string[] = [];
    for (const v of variants) {
      jidPatterns.push(`${v}@s.whatsapp.net`);
      jidPatterns.push(`${v}@lid`);
    }

    try {
      // Update messaging_contacts where:
      // - platform_id matches one of the JID patterns
      // - display_name is null, empty, looks like a phone number, or is a JID
      const result = await pgPool.query(
        `UPDATE messaging_contacts
         SET display_name = $1, phone_number = $2, updated_at = NOW()
         WHERE user_id = $3
           AND platform = 'whatsapp'
           AND platform_id = ANY($4)
           AND (
             display_name IS NULL
             OR display_name = ''
             OR display_name ~ '^\\+?[0-9][0-9 \\-()]+$'
             OR display_name LIKE '%@s.whatsapp.net'
             OR display_name LIKE '%@lid'
             OR display_name LIKE '%@g.us'
           )`,
        [name, phone, userId, jidPatterns],
      );

      if (result.rowCount && result.rowCount > 0) {
        enriched += result.rowCount;
      }
    } catch (err) {
      logger.warn('[processPhoneContacts] Failed to enrich contact', {
        name,
        phone: phone.slice(0, 4) + '...',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (enriched > 0) {
    logger.info('[processPhoneContacts] Enriched messaging contacts from address book', {
      userId,
      pushed: contacts.length,
      enriched,
    });
  }

  return enriched;
}
