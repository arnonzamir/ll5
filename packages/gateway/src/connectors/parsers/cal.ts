/**
 * Cal (Visa Cal) — app push (com.onoapps.cal4u) and CalSMS.
 *
 * No public parser fixture exists for Cal (docs/research/2026-09-06-israeli-
 * connectors.md, Section 5): the only documented shape is the generic
 * "בכרטיסך אושרה עסקה 25/08 בסך 1120 שח" quoted by Geektime. The patterns
 * below cover that shape plus the wordings Cal's push settings page describes
 * ("עסקה בסך … בוצעה בכרטיסך המסתיים ב-…", "חיוב … ב<merchant>"). They are
 * UNVERIFIED against a real Cal push; the generic extractor is the safety net,
 * and anything that does not parse is still stored as kind 'unknown'.
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput } from './types.js';
import { parseGeneric } from './sms-generic.js';

const CAL_MERCHANT: RegExp[] = [
  // "עסקה בסך 214 ₪ ב-SUPER PHARM אושרה" / "… בסך 1120 שח ב<merchant>."
  /(?:₪|ש"ח|ש''ח|שח|ILS|NIS|\$|USD|€|EUR|£|GBP)\s+ב-?\s*(.+?)(?:\s+(?:אושרה|בוצעה|נרשמה)|\.\s|\.$|,|$)/u,
  // "ב-SUPER PHARM בסך 214 ₪" / "אצל SUPER PHARM"
  /(?:עסקה|חיוב|רכישה)\s+(?:ב-|אצל\s+)\s*(.+?)\s+(?:בסך|על\s+סך|ע"ס)/u,
  /בית\s+עסק\s*:?\s+(.+?)(?:\s+(?:בסך|חייב)|\.\s|,|$)/u,
];

export function parseCal(input: ParserInput): ConnectorEventInput | null {
  return parseGeneric(input, { parser: 'cal', merchantPatterns: CAL_MERCHANT });
}
