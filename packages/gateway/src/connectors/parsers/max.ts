/**
 * Max (formerly Leumi Card) — SMS and app notifications.
 *
 * Template sources: zenmoney/sms-formats
 *   src/max-il_15750/formats:
 *     היי, ביקשת שנעדכן אותך על כל עסקת אינטרנט: היום 27/02 בית עסק ALIEXPRESS.COM  חייב את כרטיסך 0995 בסך 72.91 $ …
 *     … בית עסק GOOGLE *TEMPORARY HOLD חייב את כרטיסך 0995 בסך 5.00 שח …   (zenmoney drops these)
 *   src/לאומי-il_15701/formats (Leumi Card era, same wording):
 *     היי, ביקשת שנעדכן אותך על עסקאות בסכום גבוה: היום 01/08 בית עסק קשת טעמים ראשון לציון חייב את כרטיסך 2847 בסך 890.56 שח
 *     מסכמים עוד חודש של הוצאות: כרטיס 2847 חויב היום ב 5,564.59 ש"ח . היתרה הפנויה בכרטיס: 10,398.91 ש"ח .
 *     מסגרת הכרטיס: 2847 נוצלה כמעט במלואה. היתרה הפנויה לשימוש: 2,088.10 ש"ח.
 * Merchant = "בית עסק <merchant> חייב". A "TEMPORARY HOLD" merchant is a
 * pre-authorization, kept as a charge but flagged in the payload so the
 * reconciler can expire it.
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput } from './types.js';
import { parseGeneric } from './sms-generic.js';

const MAX_MERCHANT: RegExp[] = [
  /בית\s+עסק\s+(.+?)\s+חייב/u,
  // app push variants: "חיוב בסך 120 ₪ ב-SUPER PHARM" / "עסקה ב-SUPER PHARM בסך …"
  /(?:₪|ש"ח|שח|ILS|NIS|\$|USD|€|EUR)\s+ב-?\s*(.+?)(?:\.\s|\.$|,|$)/u,
];

export function parseMax(input: ParserInput): ConnectorEventInput | null {
  const ev = parseGeneric(input, { parser: 'max', merchantPatterns: MAX_MERCHANT });
  if (ev?.merchant && /TEMPORARY\s+HOLD/i.test(ev.merchant)) {
    ev.payload.temporary_hold = true;
  }
  return ev;
}
