/**
 * Shared, pure text helpers for the connector notification parsers.
 *
 * Everything here is deterministic string work: digit normalization, amount /
 * currency / card / date extraction, kind classification and the dedupe key.
 * No I/O, no Date.now() — `post_time` is the only clock.
 */
import crypto from 'node:crypto';
import type { ConnectorEventKind } from '@ll5/shared';

// Bidi / invisible marks that Hebrew notifications carry (RLM, LRM, isolates, soft hyphen, NBSP).
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\u00ad\ufeff]/g;

/** Map Arabic-Indic, Eastern Arabic-Indic and fullwidth digits to ASCII. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹０-９]/g, (ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 0x0660 && c <= 0x0669) return String(c - 0x0660);
    if (c >= 0x06f0 && c <= 0x06f9) return String(c - 0x06f0);
    return String(c - 0xff10);
  });
}

/** Strip bidi marks, normalize digits and Hebrew quote variants, collapse whitespace. */
export function normalizeText(s: string | null | undefined): string {
  if (!s) return '';
  return asciiDigits(s)
    .replace(INVISIBLE, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[״”“]/g, '"')
    .replace(/[׳’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Join title / text / big_text into one searchable string (big_text wins over text when it extends it). */
export function joinFields(title: string | null, text: string | null, bigText: string | null): string {
  const t = normalizeText(title);
  const body = normalizeText(bigText).length > normalizeText(text).length ? normalizeText(bigText) : normalizeText(text);
  return [t, body].filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Currency + amount
// ---------------------------------------------------------------------------

const CURRENCY_ALTS = '₪|ש"ח|ש\'\'ח|ש\\.ח\\.?|שח|NIS|ILS|\\$|USD|€|EUR|£|GBP|דולר(?:ים)?|יורו|לירות שטרלינג';
// 1,234.56 | 1234.56 | 1234 | 1 234.56 (space thousands, as zenmoney allows)
const AMOUNT_ALT = '-?\\d{1,3}(?:[, ]\\d{3})+(?:\\.\\d{1,2})?|-?\\d+(?:\\.\\d{1,2})?';

const AMOUNT_THEN_CURRENCY = new RegExp(`(${AMOUNT_ALT})\\s*(${CURRENCY_ALTS})(?![A-Za-z\\u05d0-\\u05ea])`, 'u');
const CURRENCY_THEN_AMOUNT = new RegExp(`(${CURRENCY_ALTS})\\s*(${AMOUNT_ALT})(?!\\d)`, 'u');
// "בסך 29.75 ש"ח" / "ב 5,564.59 ש"ח" / "סכום של 11411 ש"ח" — the hint makes the pick unambiguous.
const HINTED = new RegExp(`(?:בסך|ע"ס|סכום של|ב-|ב)\\s*(${AMOUNT_ALT})\\s*(${CURRENCY_ALTS})(?![A-Za-z\\u05d0-\\u05ea])`, 'u');

export function currencyCode(token: string): string {
  const t = token.replace(/\s+/g, '');
  if (/^(₪|ש"ח|ש''ח|ש\.ח\.?|שח|NIS|ILS)$/i.test(t)) return 'ILS';
  if (/^(\$|USD|דולר(ים)?)$/i.test(t)) return 'USD';
  if (/^(€|EUR|יורו)$/i.test(t)) return 'EUR';
  if (/^(£|GBP|לירותשטרלינג)$/i.test(t)) return 'GBP';
  return t.toUpperCase();
}

export interface AmountMatch {
  amount: number;
  currency: string;
  /** Character index just after the matched amount+currency (for merchant extraction). */
  end: number;
  /** Character index where the match starts. */
  start: number;
}

export function parseAmountNumber(raw: string): number | null {
  const n = Number(raw.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? Math.abs(n) : null;
}

/** First amount+currency pair in the text; hinted ("בסך …") first, then either order. */
export function extractAmount(text: string): AmountMatch | null {
  const h = HINTED.exec(text);
  if (h) {
    const amount = parseAmountNumber(h[1]);
    if (amount !== null) return { amount, currency: currencyCode(h[2]), start: h.index, end: h.index + h[0].length };
  }
  const a = AMOUNT_THEN_CURRENCY.exec(text);
  const c = CURRENCY_THEN_AMOUNT.exec(text);
  const pick = a && c ? (a.index <= c.index ? a : c) : (a ?? c);
  if (!pick) return null;
  const amountRaw = pick === a ? pick[1] : pick[2];
  const curRaw = pick === a ? pick[2] : pick[1];
  const amount = parseAmountNumber(amountRaw);
  if (amount === null) return null;
  return { amount, currency: currencyCode(curRaw), start: pick.index, end: pick.index + pick[0].length };
}

// ---------------------------------------------------------------------------
// Card last 4
// ---------------------------------------------------------------------------

const CARD_PATTERNS: RegExp[] = [
  // "בכרטיסך המסתיים ב- 6395," / "כרטיסך 0995" / "כרטיס 2847" / "מסגרת הכרטיס: 2847"
  /כרטיס(?:ך|ים)?\s*(?:המסתיים\s*ב-?\s*)?:?\s*(\d{4})(?!\d)/u,
  /המסתיים\s*ב-?\s*(\d{4})(?!\d)/u,
  /(?:\*{2,}|x{2,}|X{2,})\s?(\d{4})(?!\d)/u,
  /(?:card|ending(?: in)?)\s*#?\s*(?:\*+)?(\d{4})(?!\d)/iu,
];

export function extractCardLast4(text: string): string | null {
  for (const re of CARD_PATTERNS) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Date / time → occurred_at
// ---------------------------------------------------------------------------

// dd/mm, dd/mm/yy, dd/mm/yyyy, dd-mm; dotted only with a 4-digit year (29.75 is an amount, not a date).
const DATE_RE = /(?<![\d.,])(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2}|\d{4}))?|-(\d{1,2})(?:-(\d{4}))?|\.(\d{1,2})\.(\d{4}))(?![\d.,]*\d)/u;
const TIME_RE = /(?:בשעה\s*)?(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u;

function offsetMinutes(iso: string): number {
  const m = /([+-])(\d{2}):?(\d{2})$|Z$/.exec(iso);
  if (!m || m[0] === 'Z') return 0;
  const sign = m[1] === '-' ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function pad(n: number): string { return n < 10 ? `0${n}` : String(n); }

function isoWithOffset(utcMs: number, offMin: number): string {
  const local = new Date(utcMs + offMin * 60_000);
  const sign = offMin < 0 ? '-' : '+';
  const abs = Math.abs(offMin);
  const off = offMin === 0 ? 'Z' : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${off}`;
}

/**
 * occurred_at: the day/month (and time) named in the text, in the post_time's
 * own offset; the year comes from post_time (rolled back one year when the
 * named date would be > 36 h in the future). Falls back to post_time itself.
 */
export function extractOccurredAt(text: string, postTime: string): string {
  const postMs = Date.parse(postTime);
  if (!Number.isFinite(postMs)) return postTime;
  const off = offsetMinutes(postTime);
  const localPost = new Date(postMs + off * 60_000);
  const d = DATE_RE.exec(text);
  const t = TIME_RE.exec(text);
  if (!d && !t) return postTime;
  // Time without a date ("בשעה 09:15"): the post's own day at that time.
  const day = d ? Number(d[1]) : localPost.getUTCDate();
  const month = d ? Number(d[2] ?? d[4] ?? d[6]) : localPost.getUTCMonth() + 1;
  const yearRaw = d ? (d[3] ?? d[5] ?? d[7]) : undefined;
  if (!(day >= 1 && day <= 31 && month >= 1 && month <= 12)) return postTime;
  let year = yearRaw ? (yearRaw.length === 2 ? 2000 + Number(yearRaw) : Number(yearRaw)) : localPost.getUTCFullYear();
  const hh = t ? Number(t[1]) : localPost.getUTCHours();
  const mm = t ? Number(t[2]) : localPost.getUTCMinutes();
  const ss = t ? 0 : localPost.getUTCSeconds();
  let utc = Date.UTC(year, month - 1, day, hh, mm, ss) - off * 60_000;
  if (!yearRaw && utc - postMs > 36 * 3_600_000) { year -= 1; utc = Date.UTC(year, month - 1, day, hh, mm, ss) - off * 60_000; }
  if (Number.isNaN(utc)) return postTime;
  return isoWithOffset(utc, off);
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

export const OTP_RE = /(קוד\s*(?:ה?אימות|ה?זיהוי|ה?כניסה|חד[- ]פעמי|ה?אבטחה|ה?גישה)|סיסמ[הא]\s*(?:חד[- ]פעמית|זמנית)|הקוד\s*(?:שלך|הוא)|\bOTP\b|verification code|one[- ]time (?:code|password|passcode)|security code)/iu;
export const REFUND_RE = /(זיכוי|זוכה|זוכית|הוחזר|החזר\s+כספי|refund|credited)/iu;
export const DECLINED_RE = /(נדחתה|לא\s+אושרה|סורבה|declined)/iu;
export const BILL_RE = /(מסכמים\s+עוד\s+חודש|חיוב\s+חודשי|החיוב\s+החודשי|דף\s+החיוב|סך\s+החיוב|לתשלום\s+ב-?\s*\d)/iu;
export const CHARGE_RE = /(אושרה\s+עסקה|אושרה\s+העסקה|חייב\s+את\s+כרטיס|חוייב|חויב\s+ב|חיוב\s+(?:על|בסך|ב)|בוצעה\s+עסקה|נרשמה\s+עסקה|עסקה\s+(?:ב|על\s+סך|בסך|בוצעה)|עסקת\s+(?:אינטרנט|חו"ל|חול)|רכישה\s+ב|purchase|charged|transaction\s+(?:of|approved)|approved)/iu;
export const NOTICE_RE = /(מסגרת|יתרה\s+הפנויה|יתרת\s+(?:המסגרת|האשראי)|ניצול\s+מסגרת|80%|תזכורת)/iu;
export const MARKETING_RE = /(הטבה|מבצע|הנחה|קמפיין|הצטרפ|הורידו|מועדון|לחצ[ו]?\s+כאן|לחץ\s+כאן|נקודות|מתנה|חדש!|כנסו|גלו|הזמנה\s+מיוחדת|לכל\s+הפרטים)/iu;
export const FOREIGN_RE = /(חו"ל|חו'ל|עסקת\s+חול|abroad|foreign)/iu;

export interface KindDecision {
  kind: ConnectorEventKind;
  /** false when the amount must be dropped (unknown / notice / marketing never carry a triggering amount). */
  keepAmount: boolean;
}

export function classifyKind(text: string, hasAmount: boolean): KindDecision {
  if (OTP_RE.test(text) && /\b\d{4,8}\b/.test(text)) return { kind: 'otp', keepAmount: false };
  if (REFUND_RE.test(text) && hasAmount) return { kind: 'refund', keepAmount: true };
  if (DECLINED_RE.test(text)) return { kind: 'notice', keepAmount: hasAmount };
  if (BILL_RE.test(text) && hasAmount) return { kind: 'bill', keepAmount: true };
  // A charge keyword plus an amount is a transaction even when the text also
  // carries marketing words ("…חויב 120 ₪. הטבה חדשה באפליקציה"); marketing
  // alone (no charge keyword) falls through to notice/unknown with amount null.
  if (CHARGE_RE.test(text) && hasAmount) return { kind: 'charge', keepAmount: true };
  if (NOTICE_RE.test(text)) return { kind: 'notice', keepAmount: false };
  return { kind: 'unknown', keepAmount: false };
}

// ---------------------------------------------------------------------------
// Merchant
// ---------------------------------------------------------------------------

/** Trim a merchant candidate: trailing punctuation, URLs, "בע"מ." tails kept, surrounding quotes dropped. */
export function cleanMerchant(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let m = raw
    .replace(/https?:\/\/\S+/g, '')
    // A merchant clause ends where the sentence moves on to the time / card / status.
    .split(/\s+(?:בשעה|בכרטיס(?:ך)?|בתאריך|אושרה|בוצעה|נרשמה|למידע|לפרטים|חייב|בסך)(?=\s|$)/u)[0]
    .replace(/^[\s"'“”:,.-]+|[\s"'“”:,.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // A merchant that is only digits / symbols is noise.
  if (!/[A-Za-zא-ת]/u.test(m)) return null;
  if (m.length > 80) m = m.slice(0, 80).trim();
  return m || null;
}

/** Take the first regex whose group 1 yields a clean merchant. */
export function firstMerchant(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text);
    const cleaned = cleanMerchant(m?.[1]);
    if (cleaned) return cleaned;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dedupe key
// ---------------------------------------------------------------------------

/** sha256 of connector_id|package|post_time|title|text (package = SMS sender for SMS). Raw fields, not normalized. */
export function dedupeKey(connectorId: string, pkgOrSender: string, postTime: string, title: string | null, text: string | null): string {
  return crypto.createHash('sha256')
    .update([connectorId, pkgOrSender, postTime, title ?? '', text ?? ''].join('|'))
    .digest('hex');
}
