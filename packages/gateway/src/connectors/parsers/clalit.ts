/**
 * Clalit (HMO) — SMS from sender "CLALIT" / app pushes (clalit.android).
 *
 * Real templates read from the phone's SMS inbox on 2026-09-06 (names and
 * amounts anonymized in the fixtures, structure kept):
 *   set:        שלום <name>, נקבע לך תור ל<doctor> ב- 06/09/2026, יום א', בשעה 17:40, במרפאת <clinic>. אם ...
 *   cancelled:  שלום <name>, בוטל התור ל<doctor> ב- 06/09/2026, יום א', בשעה 17:40.
 *   rx ready:   שלום <name>, המרשם שקיבלת ממתין לך בבית המרקחת!
 *   OTP:        250975 הוא קוד האימות החד־פעמי לכללית און־ליין, והוא תקף ל־5 הדקות הקרובות. ...
 * Appointments: kind 'appointment', occurred_at = the stated date+time in
 * Asia/Jerusalem, payload.doctor / clinic / action ('set' | 'cancelled').
 * Prescription: kind 'notice', payload.subject 'prescription_ready'.
 * OTP: kind 'otp' through the generic classifier (code redacted in payload).
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput } from './types.js';
import { parseGeneric } from './sms-generic.js';
import { cleanMerchant, extractZonedDateTime, joinFields } from './common.js';

const TZ = 'Asia/Jerusalem';
const SET_RE = /נקבע\s+לך\s+תור/u;
const CANCELLED_RE = /בוטל\s+(?:לך\s+)?התור/u;
const DOCTOR_RE = /תור\s+ל-?\s*(.+?)\s+ב-?\s*\d{1,2}[/.]\d{1,2}/u;
const CLINIC_RE = /במרפאת\s+(.+?)(?:\.|,|$)/u;
const PRESCRIPTION_RE = /מרשם.*?ממתין|ממתין.*?מרשם/u;

export function parseClalit(input: ParserInput): ConnectorEventInput | null {
  const ev = parseGeneric(input, { parser: 'clalit' });
  if (!ev || ev.kind === 'otp') return ev;
  const text = joinFields(input.title, input.text, input.big_text);

  const action = SET_RE.test(text) ? 'set' : CANCELLED_RE.test(text) ? 'cancelled' : null;
  if (action) {
    ev.kind = 'appointment';
    ev.amount = null; ev.currency = null; ev.foreign = false; ev.merchant = null; ev.account_ref = null;
    ev.occurred_at = extractZonedDateTime(text, TZ) ?? input.post_time;
    ev.payload.action = action;
    ev.payload.doctor = cleanMerchant(DOCTOR_RE.exec(text)?.[1]);
    ev.payload.clinic = cleanMerchant(CLINIC_RE.exec(text)?.[1]);
    ev.payload.timezone = TZ;
    return ev;
  }
  if (PRESCRIPTION_RE.test(text)) {
    ev.kind = 'notice';
    ev.amount = null; ev.currency = null; ev.merchant = null;
    ev.payload.subject = 'prescription_ready';
  }
  return ev;
}
