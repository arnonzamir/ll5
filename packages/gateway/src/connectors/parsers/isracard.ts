/**
 * Isracard / American Express (Israel) — SMS and app notifications.
 *
 * Template source: zenmoney/sms-formats, src/הפועלים-il_15700/formats (Isracard
 * sends the same SMS for Hapoalim-issued cards):
 *   שלום, בכרטיסך 7314 אושרה עסקה ב-19/04 בסך 29.75 ש"ח בנכסי הר חוטבים בע"מ. מידע נוסף …
 *   שלום, בכרטיסך המסתיים ב- 6395, אושרה עסקה ב-31/10 בסך 23.00 ש"ח במאפיית הארץ. …
 *   … בסך 99.90 ILS בGOOGLE  Zenmoney - UNITED STATES. …
 * Merchant = the "ב<merchant>" clause right after the amount, ended by ". ".
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput } from './types.js';
import { parseGeneric } from './sms-generic.js';

const ISRACARD_MERCHANT: RegExp[] = [
  // amount + currency, then ב<merchant> up to the sentence end (". " or end of text)
  /בסך\s*[\d,. ]+\s*(?:ש"ח|ש''ח|שח|ILS|NIS|₪|\$|USD|€|EUR|£|GBP)\s+ב-?\s*(.+?)(?:\.\s|\.$|$)/u,
  // app push variants: "עסקה ב<merchant> בסך …" / "ב<merchant> על סך …"
  /(?:אושרה\s+עסקה|עסקה)\s+ב-?\s*(.+?)\s+(?:בסך|על\s+סך|ע"ס)/u,
];

export function parseIsracard(input: ParserInput): ConnectorEventInput | null {
  return parseGeneric(input, { parser: 'isracard', merchantPatterns: ISRACARD_MERCHANT });
}
