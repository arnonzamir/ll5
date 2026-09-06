/**
 * Financy adapter — pure mapping on a fixture built from the documented
 * transaction schema (docs-financy.open-finance.ai/docs/transactions.md:
 * "chargedAmount ... Negative = debit"), plus the HTTP behaviour against an
 * injected fetch: two-page pagination, token re-mint on 401, cursor advance,
 * plan 403, credential 401, and the masked account snapshot.
 */
import { describe, it, expect } from 'vitest';
import {
  FinancyAdapter,
  mapFinancyTransactions,
  financyDateFrom,
  jwtExpiryMs,
  snapshotAccount,
  FINANCY_PAGE_LIMIT,
  type FinancyTransaction,
  type FinancyAccount,
} from '../adapters/financy.js';
import { AdapterAuthError, AdapterPlanError } from '../adapters/errors.js';

const CREDS = { client_id: 'cid-test', client_secret: 'csecret-test', user_id: 'uid-test' };
const CTX = { waitForOtp: async () => null };

function jwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256' })}.${b64({ sub: 'uid-test', exp: expSeconds })}.sig`;
}

const tx = (over: Partial<FinancyTransaction> & { id: string }): FinancyTransaction => ({
  SK: `TX#${over.id}`,
  accountId: 'acc-card-1',
  connectionId: 'conn-1',
  providerId: 'max',
  type: 'NORMAL',
  merchantName: 'Shufersal',
  amount: { chargedAmount: { amount: -239.9, currency: 'ILS' }, originalAmount: { amount: -239.9, currency: 'ILS' } },
  description: { description: 'SHUFERSAL DEAL', additionalInfo: '' },
  category: { main: 'FOOD_&_DRINKS', sub: 'GROCERIES' },
  date: { transactionDate: '2026-09-01', bookingDate: '2026-09-02', valueDate: '2026-09-02' },
  balancePerEndDay: 4210.55,
  ...over,
});

const FIXTURE: FinancyTransaction[] = [
  tx({ id: 't-charge' }),
  tx({ id: 't-refund', merchantName: 'Zara', amount: { chargedAmount: { amount: 120, currency: 'ILS' }, originalAmount: { amount: 120, currency: 'ILS' } } }),
  tx({
    id: 't-installment',
    type: 'INSTALLMENT',
    merchantName: 'KSP',
    installments: { number: 2, total: 6 },
    amount: { chargedAmount: { amount: -500, currency: 'ILS' }, originalAmount: { amount: -3000, currency: 'ILS' } },
  }),
  tx({
    id: 't-foreign',
    merchantName: 'Amazon',
    debtorAccount: { maskedPan: '**** **** **** 4321' },
    amount: { chargedAmount: { amount: -73.42, currency: 'ILS' }, originalAmount: { amount: -19.99, currency: 'USD' } },
    date: { transactionDate: '2026-09-03', bookingDate: '2026-09-04', valueDate: '2026-09-04' },
  }),
  tx({ id: 't-duplicate', isDuplicate: true }),
  tx({ id: 't-no-merchant', merchantName: undefined, description: { description: 'HAAVARA BANKAIT', additionalInfo: 'ref 77' }, accountId: 'acc-checking' }),
];

const ACCOUNTS = new Map([
  ['acc-card-1', { id: 'acc-card-1', providerId: 'max', accountType: 'CARD', currency: 'ILS', balances: [], last4: '1111' }],
  ['acc-checking', { id: 'acc-checking', providerId: 'hapoalim', accountType: 'CHECKING', currency: 'ILS', balances: [], last4: '9876' }],
]);

describe('mapFinancyTransactions (pure)', () => {
  const { rows, skipped, newestDate } = mapFinancyTransactions(FIXTURE, ACCOUNTS);
  const byId = Object.fromEntries(rows.map((r) => [r.external_id, r]));

  it('negative chargedAmount = charge, positive = refund; amount stored absolute', () => {
    expect(byId['t-charge']).toMatchObject({ kind: 'charge', amount: 239.9, currency: 'ILS', merchant: 'Shufersal', category: 'GROCERIES' });
    expect(byId['t-charge'].extra).toMatchObject({ direction: 'debit', provider_id: 'max', connection_id: 'conn-1', type: 'NORMAL', foreign: false, is_duplicate: false });
    expect(byId['t-refund']).toMatchObject({ kind: 'refund', amount: 120 });
    expect(byId['t-refund'].extra).toMatchObject({ direction: 'credit' });
  });

  it('dates: occurred_at = transactionDate, posted_at = bookingDate, as UTC midnight ISO', () => {
    expect(byId['t-charge'].occurred_at).toBe('2026-09-01T00:00:00.000Z');
    expect(byId['t-charge'].posted_at).toBe('2026-09-02T00:00:00.000Z');
  });

  it('installments are typed and the original (full) amount is kept in the payload', () => {
    expect(byId['t-installment'].installments).toEqual({ number: 2, total: 6 });
    expect(byId['t-installment'].extra).toMatchObject({ type: 'INSTALLMENT', original_amount: 3000, original_currency: 'ILS' });
  });

  it('foreign = original currency differs from charged; account_ref = maskedPan last 4', () => {
    expect(byId['t-foreign']).toMatchObject({ amount: 73.42, currency: 'ILS', account_ref: '4321' });
    expect(byId['t-foreign'].extra).toMatchObject({ foreign: true, original_amount: 19.99, original_currency: 'USD' });
  });

  it('account_ref falls back to the account number last 4; merchant falls back to the description', () => {
    expect(byId['t-charge'].account_ref).toBe('1111');
    expect(byId['t-no-merchant']).toMatchObject({ merchant: 'HAAVARA BANKAIT', memo: 'ref 77', account_ref: '9876' });
    expect(byId['t-no-merchant'].extra).toMatchObject({ account_type: 'CHECKING', provider_id: 'max' });
  });

  it('skips isDuplicate items and reports the newest transaction date', () => {
    expect(byId['t-duplicate']).toBeUndefined();
    expect(skipped).toEqual({ duplicate: 1, unusable: 0 });
    expect(newestDate).toBe('2026-09-03');
    expect(rows).toHaveLength(5);
  });

  it('external_id is the id alone unless the id repeats in the batch, then id:SK', () => {
    const twice = mapFinancyTransactions([tx({ id: 'dup', SK: 'TX#dup#a' }), tx({ id: 'dup', SK: 'TX#dup#b' }), tx({ id: 'solo' })]);
    expect(twice.rows.map((r) => r.external_id).sort()).toEqual(['dup:TX#dup#a', 'dup:TX#dup#b', 'solo']);
  });

  it('never stores owner info: the account snapshot has no nationalId or fullName', () => {
    const acc: FinancyAccount = {
      id: 'a1', providerId: 'hapoalim', accountType: 'CHECKING', accountNumber: '12-345-678901', currency: 'ILS',
      balances: [{ balanceType: 'closingBooked', balanceAmount: { amount: 4210.55, currency: 'ILS' } }, { amount: 4000, currency: 'ILS' }],
      ownerInfo: { fullName: 'Someone', nationalId: '000000000' },
    };
    const snap = snapshotAccount(acc)!;
    expect(snap).toEqual({
      id: 'a1', providerId: 'hapoalim', accountType: 'CHECKING', currency: 'ILS', last4: '8901',
      balances: [{ type: 'closingBooked', amount: 4210.55, currency: 'ILS' }, { type: null, amount: 4000, currency: 'ILS' }],
    });
    expect(JSON.stringify(snap)).not.toMatch(/000000000|Someone|nationalId/);
  });

  it('dateFrom: first pull = today - 90 days; later pulls = since - 3 days', () => {
    expect(financyDateFrom(null, '2026-09-06')).toBe('2026-06-08');
    expect(financyDateFrom({ since: '2026-09-03' }, '2026-09-06')).toBe('2026-08-31');
    expect(financyDateFrom({ since: 'garbage' }, '2026-09-06')).toBe('2026-06-08');
  });

  it('reads exp from a JWT and tolerates a non-JWT token', () => {
    expect(jwtExpiryMs(jwt(1_800_000_000))).toBe(1_800_000_000_000);
    expect(jwtExpiryMs('opaque')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP behaviour against an injected fetch
// ---------------------------------------------------------------------------

interface Call { method: string; url: URL; auth: string | null; body: unknown }

function fakeApi(opts: {
  tokens?: string[];
  txPages?: Array<{ items: FinancyTransaction[]; nextPage?: string | null }>;
  accounts?: FinancyAccount[];
  connections?: unknown[];
  reject401Tokens?: Set<string>;
  plan403?: boolean;
  tokenStatus?: number;
}) {
  const calls: Call[] = [];
  const tokens = [...(opts.tokens ?? [jwt(4_000_000_000)])];
  const txPages = opts.txPages ?? [{ items: [], nextPage: null }];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    calls.push({ method: init?.method ?? 'GET', url, auth, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === '/oauth/token') {
      if (opts.tokenStatus) return json(opts.tokenStatus, { error: 'nope' });
      const t = tokens.shift() ?? 'exhausted';
      return json(200, { accessToken: t, tokenType: 'Bearer', expiresIn: 3_600_000 });
    }
    const bearer = auth?.replace('Bearer ', '') ?? '';
    if (opts.reject401Tokens?.has(bearer)) return json(401, { error: 'expired' });
    if (opts.plan403 && url.pathname === '/v2/data/transactions') return json(403, { code: 'NOT_AVAILABLE_ON_PLAN', message: 'upgrade your plan' });
    if (url.pathname === '/v2/connections') return opts.connections ? json(200, { items: opts.connections, nextPage: null }) : json(500, { error: 'boom' });
    if (url.pathname === '/v2/data/accounts') return json(200, { items: opts.accounts ?? [], nextPage: null });
    if (url.pathname === '/v2/data/transactions') {
      const cursor = url.searchParams.get('nextPage');
      const idx = cursor ? Number(cursor.replace('p', '')) : 0;
      return json(200, txPages[idx] ?? { items: [], nextPage: null });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

describe('FinancyAdapter.pull (injected fetch)', () => {
  const now = () => new Date('2026-09-06T12:00:00Z');

  it('paginates on nextPage, sends sort=1 / limit=200 / dateFrom, and only ever GETs the two data endpoints', async () => {
    const api = fakeApi({
      txPages: [
        { items: [tx({ id: 'p1a' }), tx({ id: 'p1b', date: { transactionDate: '2026-09-04', bookingDate: '2026-09-05', valueDate: '2026-09-05' } })], nextPage: 'p1' },
        { items: [tx({ id: 'p2a', date: { transactionDate: '2026-09-05', bookingDate: '2026-09-06', valueDate: '2026-09-06' } })], nextPage: null },
      ],
      accounts: [{ id: 'acc-card-1', providerId: 'max', accountType: 'CARD', accountNumber: '5555', currency: 'ILS', balances: [{ amount: -1200, currency: 'ILS' }], ownerInfo: { fullName: 'X', nationalId: '1' } }],
    });
    const adapter = new FinancyAdapter({ fetch: api.fetchImpl, now });
    const res = await adapter.pull(CREDS, null, CTX);

    expect(res.rows.map((r) => r.external_id)).toEqual(['p1a', 'p1b', 'p2a']);
    expect(res.cursor).toEqual({ since: '2026-09-05' });
    expect(res.config).toMatchObject({ accounts: [{ id: 'acc-card-1', accountType: 'CARD', last4: '5555', balances: [{ amount: -1200, currency: 'ILS' }] }] });
    expect(JSON.stringify(res.config)).not.toMatch(/nationalId|fullName/);

    const txCalls = api.calls.filter((c) => c.url.pathname === '/v2/data/transactions');
    expect(txCalls).toHaveLength(2);
    expect(Object.fromEntries(txCalls[0].url.searchParams)).toEqual({ dateFrom: '2026-06-08', sort: '1', limit: String(FINANCY_PAGE_LIMIT) });
    expect(txCalls[1].url.searchParams.get('nextPage')).toBe('p1');
    // Forbidden surface: no refresh, no payments, no non-GET data calls.
    const paths = api.calls.map((c) => `${c.method} ${c.url.pathname}`);
    expect(paths.every((p) => p === 'POST /oauth/token' || p === 'GET /v2/connections' || p === 'GET /v2/data/accounts' || p === 'GET /v2/data/transactions')).toBe(true);
    // The token POST carries the documented body keys and no credential leaks into query strings.
    expect(api.calls[0].body).toEqual({ userId: 'uid-test', clientId: 'cid-test', clientSecret: 'csecret-test' });
    expect(api.calls.some((c) => c.url.search.includes('csecret-test'))).toBe(false);
  });

  it('advances the cursor: the next pull asks from since - 3 days and reuses the cached token', async () => {
    const api = fakeApi({ txPages: [{ items: [tx({ id: 'n1', date: { transactionDate: '2026-09-06', bookingDate: '2026-09-06', valueDate: '2026-09-06' } })], nextPage: null }] });
    const adapter = new FinancyAdapter({ fetch: api.fetchImpl, now });
    const first = await adapter.pull(CREDS, { since: '2026-09-03' }, CTX);
    expect(first.cursor).toEqual({ since: '2026-09-06' });
    await adapter.pull(CREDS, first.cursor, CTX);
    const txCalls = api.calls.filter((c) => c.url.pathname === '/v2/data/transactions');
    expect(txCalls[0].url.searchParams.get('dateFrom')).toBe('2026-08-31');
    expect(txCalls[1].url.searchParams.get('dateFrom')).toBe('2026-09-03');
    expect(api.calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(1);
  });

  it('with no transactions the cursor becomes today', async () => {
    const api = fakeApi({});
    const res = await new FinancyAdapter({ fetch: api.fetchImpl, now }).pull(CREDS, null, CTX);
    expect(res.rows).toEqual([]);
    expect(res.cursor).toEqual({ since: '2026-09-06' });
  });

  it('re-mints once on 401 and succeeds with the fresh token', async () => {
    const stale = jwt(4_000_000_000) + 'stale';
    const fresh = jwt(4_000_000_001);
    const api = fakeApi({ tokens: [stale, fresh], reject401Tokens: new Set([stale]) });
    const res = await new FinancyAdapter({ fetch: api.fetchImpl, now }).pull(CREDS, null, CTX);
    expect(res.cursor).toEqual({ since: '2026-09-06' });
    expect(api.calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(2);
    const dataAuths = api.calls.filter((c) => c.url.pathname === '/v2/data/accounts').map((c) => c.auth);
    expect(dataAuths).toEqual([`Bearer ${stale}`, `Bearer ${fresh}`]);
  });

  it('a second 401 after the re-mint is an AdapterAuthError', async () => {
    const a = jwt(4_000_000_000) + 'a';
    const b = jwt(4_000_000_000) + 'b';
    const api = fakeApi({ tokens: [a, b], reject401Tokens: new Set([a, b]) });
    await expect(new FinancyAdapter({ fetch: api.fetchImpl, now }).pull(CREDS, null, CTX)).rejects.toBeInstanceOf(AdapterAuthError);
  });

  it('rejected client credentials at /oauth/token are an AdapterAuthError; incomplete creds too', async () => {
    const api = fakeApi({ tokenStatus: 401 });
    await expect(new FinancyAdapter({ fetch: api.fetchImpl, now }).pull(CREDS, null, CTX)).rejects.toBeInstanceOf(AdapterAuthError);
    await expect(new FinancyAdapter({ fetch: api.fetchImpl, now }).pull({ client_id: 'x' }, null, CTX)).rejects.toBeInstanceOf(AdapterAuthError);
  });

  it('a 403 mentioning the plan is an AdapterPlanError (code plan_not_eligible)', async () => {
    const api = fakeApi({ plan403: true });
    const err = await new FinancyAdapter({ fetch: api.fetchImpl, now }).pull(CREDS, null, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterPlanError);
    expect(err.code).toBe('plan_not_eligible');
  });

  it('re-mints when the cached token is within 30 s of its exp', async () => {
    const soon = Math.floor(now().getTime() / 1000) + 20; // expires in 20 s
    const api = fakeApi({ tokens: [jwt(soon), jwt(soon + 3600)] });
    const adapter = new FinancyAdapter({ fetch: api.fetchImpl, now });
    await adapter.pull(CREDS, null, CTX);
    await adapter.pull(CREDS, null, CTX);
    expect(api.calls.filter((c) => c.url.pathname === '/oauth/token')).toHaveLength(2);
  });
  it('stores connection freshness (lastFetchedAt, data_through) and survives a failing connections call', async () => {
    const withConn = fakeApi({
      connections: [
        { id: 'c1', providerId: 'discount', status: 'ACTIVE', lastFetchedAt: '2026-09-06T05:00:00Z', lastFetchedDataDate: { from: '2026-06-01', to: '2026-09-01' }, error: { code: 'x' } },
        { id: 'c2', providerId: 'max', status: 'ACTIVE', lastFetchedAt: '2026-09-06T06:00:00Z', lastFetchedDataDate: '2026-09-05' },
      ],
    });
    const res = await new FinancyAdapter({ fetch: withConn.fetchImpl, now }).pull(CREDS, null, CTX);
    expect(res.config).toMatchObject({
      data_through: '2026-09-05',
      connections: [
        { id: 'c1', providerId: 'discount', dataThrough: '2026-09-01', hasError: true },
        { id: 'c2', providerId: 'max', dataThrough: '2026-09-05', hasError: false, lastFetchedAt: '2026-09-06T06:00:00Z' },
      ],
    });
    expect(JSON.stringify(res.config)).not.toContain('"code":"x"');

    const noConn = fakeApi({}); // /v2/connections answers 500
    const res2 = await new FinancyAdapter({ fetch: noConn.fetchImpl, now }).pull(CREDS, null, CTX);
    expect(res2.config).toMatchObject({ connections: [], data_through: null });
  });
});

