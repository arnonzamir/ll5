/**
 * Connector parsers — fixture-driven (DECISION-029: contracts, no mocks).
 *
 * Fixture sources:
 *   - zenmoney/sms-formats (regex + real SMS samples, pushed 2026-09-05):
 *       Isracard/Amex: src/הפועלים-il_15700/formats/…_4621.txt
 *       Max:           src/max-il_15750/formats/…_4964.txt, …_5139.txt
 *       Leumi Card:    src/לאומי-il_15701/formats/…_4772.txt, …_4781.txt, …_4786.txt
 *   - docs/research/2026-09-06-israeli-connectors.md, Section 5 (Cal generic shape via Geektime)
 *   - Cal push wordings are UNVERIFIED (no public fixture) — synthetic, marked below.
 */
import { describe, it, expect } from 'vitest';
import { parse, dedupeKey, extractAmount, extractOccurredAt, normalizeText, type ParserInput } from '../connectors/parsers/index.js';

const POST = '2026-09-06T12:31:00+03:00';

function app(connector_id: string, pkg: string, text: string, title: string | null = null, big_text: string | null = null, post_time = POST): ParserInput {
  return { connector_id, package: pkg, sender: null, title, text, big_text, post_time };
}
function sms(connector_id: string, sender: string, text: string, post_time = POST): ParserInput {
  return { connector_id, package: null, sender, title: null, text, big_text: null, post_time };
}

interface Expect {
  kind: string; amount: number | null; currency?: string | null; merchant?: string | null; card?: string | null; foreign?: boolean; occurred?: string;
}
function check(input: ParserInput, e: Expect): void {
  const ev = parse(input);
  expect(ev, `parse returned null for: ${input.text}`).not.toBeNull();
  expect(ev!.connector_id).toBe(input.connector_id);
  expect(ev!.kind).toBe(e.kind);
  expect(ev!.amount).toBe(e.amount);
  if (e.currency !== undefined) expect(ev!.currency).toBe(e.currency);
  if (e.merchant !== undefined) expect(ev!.merchant).toBe(e.merchant);
  if (e.card !== undefined) expect(ev!.account_ref).toBe(e.card);
  if (e.foreign !== undefined) expect(ev!.foreign).toBe(e.foreign);
  if (e.occurred !== undefined) expect(ev!.occurred_at).toBe(e.occurred);
  expect(ev!.dedupe_key).toMatch(/^[0-9a-f]{64}$/);
  // Raw text is always kept — except OTP codes, which are redacted before storage.
  if (e.kind === 'otp') expect(String(ev!.payload.text)).not.toMatch(/\d{4,8}/);
  else expect(ev!.payload.text).toBe(input.text);
  expect(ev!.payload.post_time).toBe(input.post_time);
}

describe('isracard parser (zenmoney הפועלים-il_15700 fixtures)', () => {
  const S = 'Isracard';
  it('charge with merchant, ILS via ש"ח', () => check(
    sms('isracard', S, 'שלום, בכרטיסך 7314 אושרה עסקה ב-19/04 בסך 29.75 ש"ח בנכסי הר חוטבים בע"מ. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://4u.isracard.co.il/link/login. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 29.75, currency: 'ILS', merchant: 'נכסי הר חוטבים בע"מ', card: '7314', foreign: false, occurred: '2026-04-19T12:31:00+03:00' },
  ));
  it('charge with Latin merchant and ILS code', () => check(
    sms('isracard', S, 'שלום, בכרטיסך 7314 אושרה עסקה ב-18/04 בסך 99.90 ILS בGOOGLE  Zenmoney - UNITED STATES. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://www1.isracard.co.il/SMS/TransactionDetails. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 99.9, currency: 'ILS', merchant: 'GOOGLE Zenmoney - UNITED STATES', card: '7314', foreign: false },
  ));
  it('charge without merchant clause', () => check(
    sms('isracard', S, 'שלום, בכרטיסך 7314 אושרה עסקה ב-20/04 בסך 29.00 ש"ח. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://www1.isracard.co.il/SMS/TransactionDetails. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 29, currency: 'ILS', merchant: null, card: '7314' },
  ));
  it('"המסתיים ב- NNNN," card wording', () => check(
    sms('isracard', 'ישראכרט', 'שלום, בכרטיסך המסתיים ב- 6395, אושרה עסקה ב-31/10 בסך 23.00 ש"ח במאפיית הארץ. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://4u.isracard.co.il/link/login. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 23, currency: 'ILS', merchant: 'מאפיית הארץ', card: '6395', occurred: '2025-10-31T12:31:00+03:00' },
  ));
  it('BIT transfer wording (merchant contains ב)', () => check(
    sms('isracard', S, 'שלום, בכרטיסך 6395 אושרה עסקה ב-27/09 בסך 180.00 ש"ח בהעברה ב BIT בנה"פ. מידע נוסף ייקלט במערכות שלנו ויהיה ניתן לצפייה באתר בעוד 48 שעות https://4u.isracard.co.il/link/login. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 180, merchant: 'העברה ב BIT בנה"פ', card: '6395' },
  ));
  it('Amex variant (same issuer group) as an app notification', () => check(
    app('isracard', 'com.isracard.hapoalim', 'שלום, בכרטיסך המסתיים ב- 1188, אושרה עסקה ב-09/06 בסך 42.33 ש"ח בביג סיטי מרקט. למידע נוסף באפליקציה ובאתר: https://4u.americanexpress.co.il/sms-transactionlist. לשירותך, אמריקן אקספרס', 'ישראכרט'),
    { kind: 'charge', amount: 42.33, merchant: 'ביג סיטי מרקט', card: '1188' },
  ));
  it('foreign currency charge sets foreign', () => check(
    sms('isracard', S, 'שלום, בכרטיסך 7314 אושרה עסקה ב-02/09 בסך 12.99 USD בNETFLIX.COM. מידע נוסף ייקלט במערכות שלנו. לשירותך, קבוצת ישראכרט'),
    { kind: 'charge', amount: 12.99, currency: 'USD', merchant: 'NETFLIX.COM', foreign: true },
  ));
});

describe('max parser (zenmoney max-il_15750 + לאומי-il_15701 fixtures)', () => {
  it('internet transaction in USD, merchant via בית עסק … חייב', () => check(
    sms('max', 'max', 'היי, ביקשת שנעדכן אותך על כל עסקת אינטרנט: היום 27/02 בית עסק ALIEXPRESS.COM  חייב את כרטיסך 0995 בסך 72.91 $        כדאי לעקוב אחר החיובים כאן: http://goo.gl/hP6UaM'),
    { kind: 'charge', amount: 72.91, currency: 'USD', merchant: 'ALIEXPRESS.COM', card: '0995', foreign: true, occurred: '2026-02-27T12:31:00+03:00' },
  ));
  it('TEMPORARY HOLD pre-authorization is a charge flagged temporary_hold', () => {
    const ev = parse(sms('max', 'max', 'היי, ביקשת שנעדכן אותך על כל עסקת אינטרנט: היום 07/09 בית עסק GOOGLE *TEMPORARY HOLD חייב את כרטיסך 0995 בסך 5.00 שח כדאי לעקוב אחר החיובים כאן: http://goo.gl/hP6UaM'));
    expect(ev?.kind).toBe('charge');
    expect(ev?.amount).toBe(5);
    expect(ev?.currency).toBe('ILS');
    expect(ev?.merchant).toBe('GOOGLE *TEMPORARY HOLD');
    expect(ev?.payload.temporary_hold).toBe(true);
    expect(ev?.payload.parser).toBe('max');
  });
  it('high-amount alert with a multi-word Hebrew merchant and שח', () => check(
    sms('max', 'מקס', 'היי, ביקשת שנעדכן אותך על עסקאות בסכום גבוה: היום 01/08 בית עסק קשת טעמים ראשון לציון חייב את כרטיסך 2847 בסך 890.56 שח'),
    { kind: 'charge', amount: 890.56, currency: 'ILS', merchant: 'קשת טעמים ראשון לציון', card: '2847', foreign: false },
  ));
  it('monthly billing summary is a bill with the charged total', () => check(
    sms('max', 'MAX', 'מסכמים עוד חודש של הוצאות: כרטיס 2847 חויב היום ב 5,564.59 ש"ח . היתרה הפנויה בכרטיס: 10,398.91 ש"ח . לצפייה בפירוט החיובים:goo.gl/hP6UaM'),
    { kind: 'bill', amount: 5564.59, currency: 'ILS', card: '2847' },
  ));
  it('credit-limit notice carries no amount (a balance is not a charge)', () => check(
    sms('max', 'max', 'מסגרת הכרטיס: 2847 נוצלה כמעט במלואה. היתרה הפנויה לשימוש: 2,088.10 ש"ח. לבחינת פינוי מסגרת הכרטיס: https://goo.gl/oZrVY8'),
    { kind: 'notice', amount: null, currency: null, card: '2847' },
  ));
  it('app push with RTL marks and thousands separator', () => check(
    app('max', 'com.ideomobile.leumicard', '‏היום 06/09 בית עסק ‏SUPER-PHARM חייב את כרטיסך 0995 בסך 1,250.00 ₪', 'max'),
    { kind: 'charge', amount: 1250, currency: 'ILS', merchant: 'SUPER-PHARM', card: '0995' },
  ));
});

describe('cal parser (no public fixture — generic shape from research Section 5 + synthetic push wordings)', () => {
  it('Geektime-quoted generic shape: בכרטיסך אושרה עסקה 25/08 בסך 1120 שח', () => check(
    sms('cal', 'Cal', 'בכרטיסך אושרה עסקה 25/08 בסך 1120 שח'),
    { kind: 'charge', amount: 1120, currency: 'ILS', merchant: null, occurred: '2026-08-25T12:31:00+03:00' },
  ));
  it('synthetic push: amount then ב-<merchant>', () => check(
    app('cal', 'com.onoapps.cal4u', 'עסקה בסך 214 ₪ ב-SUPER PHARM אושרה בכרטיסך המסתיים ב-4321', 'כאל'),
    { kind: 'charge', amount: 214, currency: 'ILS', merchant: 'SUPER PHARM', card: '4321' },
  ));
  it('synthetic push: big_text extends text, Hebrew merchant, time in text', () => check(
    app('cal', 'com.onoapps.cal4u', 'אושרה עסקה בסך 89.90 ש"ח', 'Cal', 'אושרה עסקה בסך 89.90 ש"ח ברמי לוי בשעה 09:15 בכרטיס 1234.'),
    { kind: 'charge', amount: 89.9, merchant: 'רמי לוי', card: '1234', occurred: '2026-09-06T09:15:00+03:00' },
  ));
  it('synthetic foreign push: EUR + חו"ל', () => check(
    app('cal', 'com.onoapps.cal4u', 'עסקת חו"ל בסך 45.00 EUR ב-AMAZON.DE אושרה בכרטיסך 4321', 'Cal'),
    { kind: 'charge', amount: 45, currency: 'EUR', merchant: 'AMAZON.DE', foreign: true },
  ));
  it('synthetic refund', () => check(
    app('cal', 'com.onoapps.cal4u', 'זיכוי בסך 120 ₪ מ-SUPER PHARM נרשם בכרטיסך 4321', 'Cal'),
    { kind: 'refund', amount: 120, currency: 'ILS' },
  ));
});

describe('clalit parser (real SMS templates from the phone, 2026-09-06, anonymized)', () => {
  const S = 'CLALIT';
  it('appointment set → kind appointment at the stated Jerusalem time, doctor + clinic + action', () => {
    const ev = parse(sms('clalit', S, "שלום ישראל, נקבע לך תור לד\"ר לוי כהן ב- 06/09/2026, יום א', בשעה 17:40, במרפאת מרפאת פסגת זכרון. אם ברצונך לבטל את התור, היכנס לאפליקציה."));
    expect(ev?.kind).toBe('appointment');
    expect(ev?.occurred_at).toBe('2026-09-06T17:40:00+03:00');
    expect(ev?.amount).toBeNull();
    expect(ev?.payload).toMatchObject({ action: 'set', doctor: 'ד"ר לוי כהן', clinic: 'מרפאת פסגת זכרון', parser: 'clalit' });
  });
  it('appointment in winter time gets the +02:00 offset', () => {
    const ev = parse(sms('clalit', 'Clalit', "שלום ישראל, נקבע לך תור לד\"ר לוי כהן ב- 15/01/2027, יום ו', בשעה 08:30, במרפאת מרפאת רמת אביב."));
    expect(ev?.occurred_at).toBe('2027-01-15T08:30:00+02:00');
  });
  it('appointment cancelled → action cancelled', () => {
    const ev = parse(sms('clalit', S, "שלום ישראל, בוטל התור לד\"ר לוי כהן ב- 06/09/2026, יום א', בשעה 17:40."));
    expect(ev?.kind).toBe('appointment');
    expect(ev?.occurred_at).toBe('2026-09-06T17:40:00+03:00');
    expect(ev?.payload).toMatchObject({ action: 'cancelled', doctor: 'ד"ר לוי כהן', clinic: null });
  });
  it('prescription ready → notice with subject', () => {
    const ev = parse(sms('clalit', S, 'שלום ישראל, המרשם שקיבלת ממתין לך בבית המרקחת!'));
    expect(ev?.kind).toBe('notice');
    expect(ev?.amount).toBeNull();
    expect(ev?.payload.subject).toBe('prescription_ready');
  });
  it('OTP with maqaf wording → otp, code redacted in the payload', () => {
    const ev = parse(sms('clalit', S, '250975 הוא קוד האימות החד־פעמי לכללית און־ליין, והוא תקף ל־5 הדקות הקרובות. אין למסור את הקוד לאף אחד.'));
    expect(ev?.kind).toBe('otp');
    expect(ev?.amount).toBeNull();
    expect(String(ev?.payload.text)).not.toContain('250975');
    expect(String(ev?.payload.text)).toContain('<redacted>');
    expect(String(ev?.payload.normalized)).not.toContain('250975');
  });
});

describe('generic parser for the other catalog ids (bank, paybox, water)', () => {
  it('water bill from MayanotH: ע"ס without a currency token → bill, 729.27 ILS', () => {
    const ev = parse(sms('water', 'MayanotH', 'ישראלי ישראל שלום, בימים אלו מופק חשבון המים התקופתי ע"ס 729.27. מצ"ב לנוחיותך קישור לתשלום מהיר https://example.invalid/pay'));
    expect(ev?.connector_id).toBe('water');
    expect(ev?.kind).toBe('bill');
    expect(ev?.amount).toBe(729.27);
    expect(ev?.currency).toBe('ILS');
    expect(ev?.payload.parser).toBe('sms-generic');
  });
  it('OneZero bank OTP with <#> prefix → otp, code redacted', () => {
    const ev = parse(sms('bank', 'ONEZEROBANK', '<#>(בנק וואן זירו) קוד האימות שלך הוא 467834'));
    expect(ev?.kind).toBe('otp');
    expect(String(ev?.payload.text)).toBe('<#>(בנק וואן זירו) קוד האימות שלך הוא <redacted>');
  });
  it('Cal OTP for bit registration → otp, never a charge', () => {
    const ev = parse(sms('cal', 'Cal', '8822 הינו קוד האימות החד פעמי של כרטיס האשראי שלך לרישום באפליקציית bit.'));
    expect(ev?.kind).toBe('otp');
    expect(ev?.amount).toBeNull();
    expect(String(ev?.payload.text)).not.toContain('8822');
  });
  it('unknown wording from a catalog package with no amount → unknown, raw fields kept', () => {
    const ev = parse(app('paybox', 'com.payboxapp', 'יש לך בקשה חדשה מדנה', 'PayBox'));
    expect(ev?.kind).toBe('unknown');
    expect(ev?.amount).toBeNull();
    expect(ev?.payload).toMatchObject({ package: 'com.payboxapp', title: 'PayBox', text: 'יש לך בקשה חדשה מדנה', big_text: null });
  });
  it('app push fallback: amount + no known wording → charge, title as merchant candidate', () => {
    const ev = parse(app('bank', 'com.ideomobile.discount', 'שולם 349.90 ₪', 'רמי לוי שיווק השקמה'));
    expect(ev?.kind).toBe('charge');
    expect(ev?.amount).toBe(349.9);
    expect(ev?.currency).toBe('ILS');
    expect(ev?.merchant).toBe('רמי לוי שיווק השקמה');
    expect(ev?.payload.merchant_source).toBe('title');
  });
  it('app push fallback: currency before the number; a brand-name title is not a merchant', () => {
    const ev = parse(app('paybox', 'com.payboxapp', '₪120 הועברו בהצלחה', 'PayBox'));
    expect(ev?.kind).toBe('charge');
    expect(ev?.amount).toBe(120);
    expect(ev?.merchant).toBeNull();
    expect(ev?.payload.merchant_source).toBeUndefined();
  });
  it('SMS fallback (no package) with an amount but no wording stays unknown, amount dropped', () => {
    const ev = parse(sms('bank', 'Leumi', 'יתרה: 5,000 ₪'));
    expect(ev?.kind).toBe('unknown');
    expect(ev?.amount).toBeNull();
    expect(ev?.payload.text).toBe('יתרה: 5,000 ₪');
  });
});

describe('negatives — never a charge', () => {
  it('OTP from a catalog sender becomes kind otp with no amount', () => check(
    sms('isracard', 'Isracard', 'קוד האימות שלך לכניסה לאתר ישראכרט הוא 482913. הקוד תקף ל-5 דקות.'),
    { kind: 'otp', amount: null, currency: null, merchant: null, card: null },
  ));
  it('OTP in English', () => check(
    app('max', 'com.ideomobile.leumicard', 'Your one-time code is 123456. Do not share it.', 'max'),
    { kind: 'otp', amount: null },
  ));
  it('marketing push with an amount is unknown, amount null', () => check(
    app('cal', 'com.onoapps.cal4u', 'הטבה מיוחדת! 50 ₪ הנחה בסופר פארם לחברי מועדון. לחצו כאן', 'Cal'),
    { kind: 'unknown', amount: null, currency: null, merchant: null },
  ));
  it('marketing push without numbers is unknown', () => check(
    app('max', 'com.ideomobile.leumicard', 'חדש! גלו את עולם ההטבות של max באפליקציה', 'max'),
    { kind: 'unknown', amount: null },
  ));
  it('declined transaction is a notice, not a charge', () => check(
    sms('cal', 'כאל', 'עסקה בסך 3,000 ש"ח בכרטיסך 4321 לא אושרה. לפרטים פנו למוקד.'),
    { kind: 'notice', amount: 3000 },
  ));
  it('Leumi bank salary credit through the generic parser is a refund-like credit, not a charge', () => {
    const ev = parse(sms('bank', 'Leumi', 'עדכון מלאומי: התקבל סכום של 11411 ש"ח מהעברת משכורת י (בחשבון המסתיים ב- 90758). מילת זיהוי: שלום'));
    expect(ev?.kind).not.toBe('charge');
    expect(ev?.kind).not.toBe('otp');
    expect(ev?.payload.parser).toBe('sms-generic');
  });
  it('empty notification returns null', () => {
    expect(parse(app('cal', 'com.onoapps.cal4u', null, null, null))).toBeNull();
    expect(parse(app('cal', 'com.onoapps.cal4u', '   ', '‏', null))).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizes Arabic-Indic and fullwidth digits, strips bidi marks and NBSP', () => {
    expect(normalizeText('‏בסך ١٢٣.٤٥ ש״ח')).toBe('בסך 123.45 ש"ח');
    expect(normalizeText('１２３ ILS')).toBe('123 ILS');
  });
  it('extractAmount: hinted, either order, thousands, currency codes', () => {
    expect(extractAmount('בסך 1,234.56 ש"ח')).toMatchObject({ amount: 1234.56, currency: 'ILS' });
    expect(extractAmount('₪214 בסופר')).toMatchObject({ amount: 214, currency: 'ILS' });
    expect(extractAmount('$72.91 at ALI')).toMatchObject({ amount: 72.91, currency: 'USD' });
    expect(extractAmount('סכום של 11411 ש"ח')).toMatchObject({ amount: 11411, currency: 'ILS' });
    expect(extractAmount('45.00 EUR')).toMatchObject({ amount: 45, currency: 'EUR' });
    expect(extractAmount('30 NIS')).toMatchObject({ amount: 30, currency: 'ILS' });
    expect(extractAmount('no money here')).toBeNull();
  });
  it('extractOccurredAt: day/month from text, year from post_time, rolls back across new year, keeps offset', () => {
    expect(extractOccurredAt('היום 27/02 בית עסק', '2026-03-01T10:00:00+02:00')).toBe('2026-02-27T10:00:00+02:00');
    expect(extractOccurredAt('ב-31/12 בסך', '2026-01-02T08:00:00+02:00')).toBe('2025-12-31T08:00:00+02:00');
    expect(extractOccurredAt('01/08/2025 בשעה 14:05', '2026-09-06T12:31:00+03:00')).toBe('2025-08-01T14:05:00+03:00');
    expect(extractOccurredAt('בסך 29.75 ש"ח', POST)).toBe(POST);
    expect(extractOccurredAt('anything', 'not-a-date')).toBe('not-a-date');
  });
});

describe('dedupe key', () => {
  it('is stable for identical raw input and sha256-shaped', () => {
    const a = dedupeKey('cal', 'com.onoapps.cal4u', POST, 'Cal', 'עסקה בסך 214 ₪');
    const b = dedupeKey('cal', 'com.onoapps.cal4u', POST, 'Cal', 'עסקה בסך 214 ₪');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it('changes with any of connector, package, post_time, title, text', () => {
    const base = dedupeKey('cal', 'p', POST, 't', 'x');
    expect(dedupeKey('max', 'p', POST, 't', 'x')).not.toBe(base);
    expect(dedupeKey('cal', 'q', POST, 't', 'x')).not.toBe(base);
    expect(dedupeKey('cal', 'p', '2026-09-06T12:32:00+03:00', 't', 'x')).not.toBe(base);
    expect(dedupeKey('cal', 'p', POST, 'u', 'x')).not.toBe(base);
    expect(dedupeKey('cal', 'p', POST, 't', 'y')).not.toBe(base);
  });
  it('treats null title/text as empty strings and uses the SMS sender as the package slot', () => {
    expect(dedupeKey('cal', 'Cal', POST, null, null)).toBe(dedupeKey('cal', 'Cal', POST, '', ''));
    const ev = parse(sms('cal', 'Cal', 'בכרטיסך אושרה עסקה 25/08 בסך 1120 שח'));
    expect(ev?.dedupe_key).toBe(dedupeKey('cal', 'Cal', POST, null, 'בכרטיסך אושרה עסקה 25/08 בסך 1120 שח'));
  });
  it('is computed from the RAW text, so the same push with different bidi marks is a different key', () => {
    expect(parse(sms('cal', 'Cal', 'עסקה בסך 214 ₪'))?.dedupe_key)
      .not.toBe(parse(sms('cal', 'Cal', '‏עסקה בסך 214 ₪'))?.dedupe_key);
  });
});
