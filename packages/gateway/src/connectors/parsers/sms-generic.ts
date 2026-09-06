/**
 * Generic connector notification parser — the fallback for every connector and
 * the base the issuer parsers build on. Extracts amount + currency, card last
 * 4, merchant, date, classifies the kind, and always returns an event when
 * there is any text (kind 'unknown', amount null, when nothing parses), so the
 * raw notification is still stored by the connectors MCP — Phase 1's first
 * job is collecting real samples, so title/text/big_text always go into the
 * payload (OTP codes redacted).
 *
 * App pushes (a `package` is present): an amount with no other recognizable
 * shape is a charge, with the notification title as the merchant candidate
 * when the title is not just the app's own brand name (the cards on the real
 * phone send no per-transaction SMS; their push wordings are not public yet).
 */
import type { ConnectorEventInput } from '@ll5/shared';
import type { ParserInput, ParserName } from './types.js';
import {
  classifyKind, cleanMerchant, dedupeKey, extractAmount, extractCardLast4, extractOccurredAt, firstMerchant,
  joinFields, normalizeText, redactCodes, FOREIGN_RE,
} from './common.js';

export interface GenericOptions {
  parser: ParserName;
  /** Issuer-specific merchant patterns tried before the generic ones. Group 1 = merchant. */
  merchantPatterns?: RegExp[];
}

// Generic merchant shapes, in order of confidence:
//  - "בית עסק <merchant> חייב"           (Max / Leumi Card)
//  - "בסך 29.75 ש"ח בנכסי הר חוטבים בע"מ." (Isracard: ב<merchant> right after the amount, ends at ". ")
//  - "ב-<merchant>" / "אצל <merchant>" / "at <merchant>" up to a sentence end
const GENERIC_MERCHANT: RegExp[] = [
  /בית\s+עסק\s+(.+?)\s+חייב/u,
  /(?:ILS|NIS|USD|EUR|GBP|₪|ש"ח|ש''ח|שח|ש\.ח\.?|\$|€|£)\s+ב-?\s*(.+?)(?:\.\s|\.$|$)/u,
  /(?:אצל|at)\s+(.+?)(?:\.\s|\.$|,|$)/iu,
];

// Titles that are the app's own name, never a merchant.
const BRAND_TITLES = new Set([
  'cal', 'כאל', 'max', 'מקס', 'isracard', 'ישראכרט', 'amex', 'אמריקן אקספרס', 'clalit', 'כללית',
  'paybox', 'פייבוקס', 'discount', 'דיסקונט', 'בנק דיסקונט', 'leumi', 'לאומי', 'בנק לאומי', 'bank', 'bit', 'ביט',
  'iec', 'חברת החשמל', 'water', 'מי הוד השרון', 'onezero', 'one zero', 'וואן זירו',
]);

function titleAsMerchant(input: ParserInput): string | null {
  if (!input.package) return null;
  const t = normalizeText(input.title);
  if (!t || BRAND_TITLES.has(t.toLowerCase()) || t.toLowerCase() === input.connector_id) return null;
  return cleanMerchant(t);
}

export function parseGeneric(input: ParserInput, opts: GenericOptions): ConnectorEventInput | null {
  const text = joinFields(input.title, input.text, input.big_text);
  if (!text) return null;

  const amountMatch = extractAmount(text);
  const decision = classifyKind(text, amountMatch !== null, { amountImpliesCharge: !!input.package });
  const amount = decision.keepAmount && amountMatch ? amountMatch.amount : null;
  const currency = decision.keepAmount && amountMatch ? amountMatch.currency : null;
  const carriesTransaction = decision.kind === 'charge' || decision.kind === 'refund' || decision.kind === 'bill';

  let merchantSource: 'pattern' | 'title' | null = null;
  let merchant: string | null = null;
  if (carriesTransaction) {
    merchant = firstMerchant(text, [...(opts.merchantPatterns ?? []), ...GENERIC_MERCHANT]);
    if (merchant) merchantSource = 'pattern';
    else if (decision.kind === 'charge') { merchant = titleAsMerchant(input); if (merchant) merchantSource = 'title'; }
  }
  const accountRef = decision.kind === 'otp' ? null : extractCardLast4(text);
  const foreign = carriesTransaction && ((currency !== null && currency !== 'ILS') || FOREIGN_RE.test(text));
  const pkgOrSender = input.package ?? input.sender ?? '';
  const otp = decision.kind === 'otp';
  const raw = (s: string | null) => (otp ? redactCodes(s) : s);

  return {
    connector_id: input.connector_id,
    kind: decision.kind,
    occurred_at: carriesTransaction ? extractOccurredAt(text, input.post_time) : input.post_time,
    amount,
    currency,
    foreign,
    merchant,
    account_ref: accountRef,
    dedupe_key: dedupeKey(input.connector_id, pkgOrSender, input.post_time, input.title, input.text),
    payload: {
      source: input.package ? 'app_notification' : 'sms',
      package: input.package ?? null,
      sender: input.sender ?? null,
      title: raw(input.title),
      text: raw(input.text),
      big_text: raw(input.big_text),
      post_time: input.post_time,
      parser: opts.parser,
      normalized: raw(normalizeText(text).slice(0, 1000)),
      ...(merchantSource ? { merchant_source: merchantSource } : {}),
    },
  };
}

export function parseSmsGeneric(input: ParserInput): ConnectorEventInput | null {
  return parseGeneric(input, { parser: 'sms-generic' });
}
