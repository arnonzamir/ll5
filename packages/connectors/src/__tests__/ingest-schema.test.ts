import { describe, it, expect } from 'vitest';
import { IngestLedgerRowsSchema, LedgerRowSchema, ConnectorEventInputSchema } from '../tools/schemas.js';

const good = {
  external_id: 'clalit-appt-8812',
  kind: 'appointment',
  occurred_at: '2026-09-10T09:30:00+03:00',
  memo: 'Dr. Levi, dermatology',
  category: 'appointment',
};

describe('ingest_ledger_rows schema (strict, no free text beyond memo ≤ 200)', () => {
  it('accepts a well-formed batch', () => {
    const r = IngestLedgerRowsSchema.safeParse({ connector_id: 'clalit', rows: [good] });
    expect(r.success).toBe(true);
  });

  it('refuses free text: unknown keys on a row', () => {
    const r = LedgerRowSchema.safeParse({ ...good, notes: 'the doctor said to come back in a month' });
    expect(r.success).toBe(false);
    expect(r.success ? '' : r.error.issues[0].code).toBe('unrecognized_keys');
  });

  it('refuses a memo over 200 chars and accepts one at 200', () => {
    expect(LedgerRowSchema.safeParse({ ...good, memo: 'x'.repeat(201) }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, memo: 'x'.repeat(200) }).success).toBe(true);
  });

  it('refuses more than 200 rows and an empty batch', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ ...good, external_id: `id-${i}` }));
    expect(IngestLedgerRowsSchema.safeParse({ connector_id: 'clalit', rows }).success).toBe(false);
    expect(IngestLedgerRowsSchema.safeParse({ connector_id: 'clalit', rows: rows.slice(0, 200) }).success).toBe(true);
    expect(IngestLedgerRowsSchema.safeParse({ connector_id: 'clalit', rows: [] }).success).toBe(false);
  });

  it('refuses a bad kind, a non-ISO date, a non-ISO currency and a non-finite amount', () => {
    expect(LedgerRowSchema.safeParse({ ...good, kind: 'otp' }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, kind: 'note' }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, occurred_at: '10/09/2026' }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, amount: 12, currency: 'nis' }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, amount: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(LedgerRowSchema.safeParse({ ...good, amount: 12.5, currency: 'ILS' }).success).toBe(true);
  });

  it('refuses a prose blob where a row is expected', () => {
    const r = IngestLedgerRowsSchema.safeParse({ connector_id: 'clalit', rows: ['Appointment with Dr Levi on the 10th'] });
    expect(r.success).toBe(false);
  });
});

describe('POST /api/events body schema', () => {
  const ev = {
    connector_id: 'cal',
    kind: 'charge',
    occurred_at: '2026-09-06T12:31:00Z',
    amount: 214.9,
    currency: 'ILS',
    merchant: 'SUPER-PHARM TLV',
    dedupe_key: 'a'.repeat(64),
    payload: { package: 'com.onoapps.cal4u', title: 'Cal', text: '214.90 ILS at SUPER-PHARM' },
  };
  it('accepts the gateway envelope and refuses extra top-level keys', () => {
    expect(ConnectorEventInputSchema.safeParse(ev).success).toBe(true);
    expect(ConnectorEventInputSchema.safeParse({ ...ev, user_id: 'someone-else' }).success).toBe(false);
  });
  it('requires a dedupe_key of at least 8 chars', () => {
    expect(ConnectorEventInputSchema.safeParse({ ...ev, dedupe_key: 'short' }).success).toBe(false);
  });
});
