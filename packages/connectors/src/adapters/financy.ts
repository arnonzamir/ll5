/**
 * Financy (Open-Finance.ai) ledger adapter — a licensed Israeli open-banking
 * aggregator. READ-ONLY: only `GET /v2/connections`, `GET /v2/data/accounts` and
 * `GET /v2/data/transactions` are called (plus the token mint). The refresh
 * endpoint (`/connections/refresh`, costs credits) and every payment endpoint
 * are never called; the adapter reads whatever Financy has already fetched.
 *
 * Conventions verified against docs-financy.open-finance.ai on 2026-09-06:
 *   - `amount.chargedAmount.amount` is negative for a debit ("Negative = debit"),
 *     positive for money in. We store the absolute amount and kind charge /
 *     refund from the sign (payload `direction` keeps debit / credit).
 *   - dates are `YYYY-MM-DD` strings in `date.{transactionDate,bookingDate,valueDate}`.
 *   - `isDuplicate: true` = the same transaction seen through a second link;
 *     skipped (and not requested: includeDuplicates stays at its default 0).
 *   - transactions carry no documented `status` field; when one is present it
 *     is passed through into the payload untouched.
 *   - `ownerInfo.nationalId` on accounts is never stored.
 *
 * Token: POST /oauth/token { userId, clientId, clientSecret } → { accessToken,
 * tokenType, expiresIn }. The access token is a JWT; it is cached in memory per
 * credential hash until `exp - 30 s` (fallback: expiresIn). A 401 re-mints once,
 * a second 401 is an AdapterAuthError. A 403 whose body mentions the plan is an
 * AdapterPlanError. Credential values are never logged.
 */
import { createHash } from 'node:crypto';
import type { ConnectorAdapter, PullContext, PullResult } from './adapter.js';
import { AdapterAuthError, AdapterPlanError } from './errors.js';
import type { LedgerRowInput } from '../types.js';
import { logger } from '../utils/logger.js';

export const FINANCY_API_BASE = 'https://api.open-finance.ai';
export const FINANCY_PAGE_LIMIT = 200;
export const FINANCY_FIRST_PULL_DAYS = 90;
export const FINANCY_OVERLAP_DAYS = 3;
export const FINANCY_TOKEN_SKEW_MS = 30_000;
/** Hard stop on pagination so a misbehaving cursor cannot loop forever. */
const MAX_PAGES = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FinancyCursor {
  /** YYYY-MM-DD: the newest transaction date seen. */
  since: string;
}

export interface FinancyAdapterOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  baseUrl?: string;
}

interface FinancyCreds {
  client_id: string;
  client_secret: string;
  user_id: string;
}

interface Money {
  amount?: number;
  currency?: string;
}

/** The transaction shape as documented (fields we read; anything else is ignored). */
export interface FinancyTransaction {
  id?: string;
  SK?: string;
  accountId?: string;
  connectionId?: string;
  providerId?: string;
  transactionProviderIdentifier?: string;
  date?: { valueDate?: string; bookingDate?: string; transactionDate?: string };
  amount?: { originalAmount?: Money; chargedAmount?: Money };
  description?: { description?: string; additionalInfo?: string };
  merchantName?: string;
  category?: { main?: string; sub?: string };
  status?: string;
  type?: string;
  installments?: { number?: number; total?: number };
  isDuplicate?: boolean;
  balancePerEndDay?: number;
  debtorAccount?: { maskedPan?: string };
  code?: string;
}

/** A Financy connection (one linked bank/card login) as returned by GET /v2/connections. */
export interface FinancyConnection {
  id: string;
  providerId?: string;
  status?: string;
  lastFetchedAt?: string;
  lastFetchedDataDate?: string | { from?: string; to?: string } | null;
  error?: unknown;
}

/** What goes into `config.connections`: freshness only, no error bodies. */
export interface FinancyConnectionSnapshot {
  id: string;
  providerId: string | null;
  status: string | null;
  /** Most recent fetch attempt by Financy (success or failure), ISO. */
  lastFetchedAt: string | null;
  /** Latest day of transaction data Financy holds for this connection, YYYY-MM-DD. */
  dataThrough: string | null;
  hasError: boolean;
}

export function snapshotConnection(c: FinancyConnection): FinancyConnectionSnapshot | null {
  if (!c || typeof c.id !== 'string' || !c.id) return null;
  const d = c.lastFetchedDataDate;
  const dataThrough = typeof d === 'string' ? d.slice(0, 10) : d && typeof d === 'object' && typeof d.to === 'string' ? d.to.slice(0, 10) : null;
  return {
    id: c.id,
    providerId: c.providerId ?? null,
    status: c.status ?? null,
    lastFetchedAt: c.lastFetchedAt ?? null,
    dataThrough,
    hasError: c.error != null && c.error !== false,
  };
}

export interface FinancyAccount {
  id?: string;
  providerId?: string;
  connectionId?: string;
  accountNumber?: string;
  accountType?: string;
  status?: string;
  currency?: string;
  balances?: Array<{ amount?: number; currency?: string; balanceType?: string; balanceAmount?: Money }>;
  cardDueDate?: string;
  creditStatus?: string;
  ownerInfo?: { fullName?: string; nationalId?: string };
}

/** What goes into `config.accounts`: masked, no owner info. */
export interface FinancyAccountSnapshot {
  id: string;
  providerId: string | null;
  accountType: string | null;
  currency: string | null;
  balances: Array<{ type: string | null; amount: number; currency: string | null }>;
  last4: string | null;
}

interface TokenEntry {
  token: string;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function last4(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/\D+/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function minusDays(ymdStr: string, days: number): string {
  const t = Date.parse(`${ymdStr}T00:00:00.000Z`);
  return ymd(new Date(t - days * 86_400_000));
}

function toIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (DATE_RE.test(value)) return `${value}T00:00:00.000Z`;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Read `exp` (seconds) from a JWT payload without verifying it; null when absent. */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export function snapshotAccount(a: FinancyAccount): FinancyAccountSnapshot | null {
  if (!a.id) return null;
  const balances: FinancyAccountSnapshot['balances'] = [];
  for (const b of a.balances ?? []) {
    const amount = typeof b.amount === 'number' ? b.amount : b.balanceAmount?.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount)) continue;
    balances.push({
      type: b.balanceType ?? null,
      amount,
      currency: b.currency ?? b.balanceAmount?.currency ?? a.currency ?? null,
    });
  }
  return {
    id: a.id,
    providerId: a.providerId ?? null,
    accountType: a.accountType ?? null,
    currency: a.currency ?? null,
    balances,
    last4: last4(a.accountNumber),
  };
}

/**
 * Transactions → ledger rows. Pure. Duplicates (`isDuplicate`) and items
 * without an id, a charged amount or a date are skipped. `external_id` is the
 * Financy `id`; when the same id occurs more than once in the batch, `:${SK}`
 * is appended so the rows stay distinct.
 */
export function mapFinancyTransactions(
  items: FinancyTransaction[],
  accounts: ReadonlyMap<string, FinancyAccountSnapshot> = new Map(),
): { rows: LedgerRowInput[]; skipped: { duplicate: number; unusable: number }; newestDate: string | null } {
  const idCounts = new Map<string, number>();
  for (const tx of items) if (tx.id) idCounts.set(tx.id, (idCounts.get(tx.id) ?? 0) + 1);

  const rows: LedgerRowInput[] = [];
  let duplicate = 0;
  let unusable = 0;
  let newestDate: string | null = null;

  for (const tx of items) {
    if (tx.isDuplicate) { duplicate++; continue; }
    const charged = tx.amount?.chargedAmount;
    const original = tx.amount?.originalAmount;
    const signed = charged?.amount ?? original?.amount;
    const dateStr = tx.date?.transactionDate ?? tx.date?.valueDate ?? tx.date?.bookingDate;
    const occurred_at = toIso(dateStr);
    if (!tx.id || typeof signed !== 'number' || !Number.isFinite(signed) || !occurred_at) { unusable++; continue; }

    const account = tx.accountId ? accounts.get(tx.accountId) : undefined;
    const originalCurrency = original?.currency ?? null;
    const chargedCurrency = charged?.currency ?? originalCurrency ?? account?.currency ?? null;
    const foreign = originalCurrency != null && chargedCurrency != null && originalCurrency !== chargedCurrency;
    const merchant = (tx.merchantName ?? '').trim() || (tx.description?.description ?? '').trim() || null;
    const memo = (tx.description?.additionalInfo ?? '').trim().slice(0, 200) || null;
    const installments =
      tx.installments && typeof tx.installments.number === 'number' && typeof tx.installments.total === 'number'
        ? { number: tx.installments.number, total: tx.installments.total }
        : null;
    const external_id = (idCounts.get(tx.id) ?? 0) > 1 && tx.SK ? `${tx.id}:${tx.SK}` : tx.id;

    rows.push({
      external_id,
      kind: signed < 0 ? 'charge' : 'refund',
      occurred_at,
      posted_at: toIso(tx.date?.bookingDate),
      amount: Math.abs(signed),
      currency: chargedCurrency,
      merchant,
      memo,
      account_ref: last4(tx.debtorAccount?.maskedPan) ?? account?.last4 ?? null,
      category: tx.category?.sub ?? tx.category?.main ?? null,
      installments,
      extra: {
        source: 'financy',
        sk: tx.SK ?? null,
        direction: signed < 0 ? 'debit' : 'credit',
        provider_id: tx.providerId ?? account?.providerId ?? null,
        connection_id: tx.connectionId ?? null,
        account_id: tx.accountId ?? null,
        account_type: account?.accountType ?? null,
        category: { main: tx.category?.main ?? null, sub: tx.category?.sub ?? null },
        status: tx.status ?? null,
        type: tx.type ?? null,
        installments,
        original_amount: typeof original?.amount === 'number' ? Math.abs(original.amount) : null,
        original_currency: originalCurrency,
        foreign,
        is_duplicate: false,
        value_date: tx.date?.valueDate ?? null,
        transaction_provider_identifier: tx.transactionProviderIdentifier ?? null,
        code: tx.code ?? null,
      },
    });
    if (typeof dateStr === 'string' && DATE_RE.test(dateStr) && (newestDate == null || dateStr > newestDate)) newestDate = dateStr;
  }
  return { rows, skipped: { duplicate, unusable }, newestDate };
}

/** dateFrom for a pull: cursor.since minus the overlap, or today minus 90 days on the first pull. */
export function financyDateFrom(cursor: unknown, today: string): string {
  const since = (cursor as Partial<FinancyCursor> | null)?.since;
  if (typeof since === 'string' && DATE_RE.test(since)) return minusDays(since, FINANCY_OVERLAP_DAYS);
  return minusDays(today, FINANCY_FIRST_PULL_DAYS);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

function readCreds(creds: Record<string, unknown>): FinancyCreds {
  const s = (k: string) => (typeof creds[k] === 'string' ? (creds[k] as string).trim() : '');
  const out = { client_id: s('client_id'), client_secret: s('client_secret'), user_id: s('user_id') };
  if (!out.client_id || !out.client_secret || !out.user_id) {
    throw new AdapterAuthError('Financy credentials incomplete: client_id, client_secret and user_id are required');
  }
  return out;
}

export class FinancyAdapter implements ConnectorAdapter {
  readonly id = 'financy';
  readonly authType = 'oauth' as const;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  /** sha256(credentials) → cached access token. Per process, never persisted. */
  private readonly tokens = new Map<string, TokenEntry>();

  constructor(opts: FinancyAdapterOptions = {}) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.now = opts.now ?? (() => new Date());
    this.baseUrl = (opts.baseUrl ?? FINANCY_API_BASE).replace(/\/+$/, '');
  }

  async pull(rawCreds: Record<string, unknown>, cursor: unknown, _ctx: PullContext): Promise<PullResult> {
    const creds = readCreds(rawCreds);
    const today = ymd(this.now());
    const dateFrom = financyDateFrom(cursor, today);

    const accountsById = new Map<string, FinancyAccountSnapshot>();
    const accountItems = await this.paginate<FinancyAccount>(creds, '/v2/data/accounts', { limit: String(FINANCY_PAGE_LIMIT) });
    for (const a of accountItems) {
      const snap = snapshotAccount(a);
      if (snap) accountsById.set(snap.id, snap);
    }

    const txItems = await this.paginate<FinancyTransaction>(creds, '/v2/data/transactions', {
      dateFrom,
      sort: '1',
      limit: String(FINANCY_PAGE_LIMIT),
    });
    const mapped = mapFinancyTransactions(txItems, accountsById);

    // Freshness: Financy refreshes the banks on its own plan cadence and has no
    // data webhooks, so the ledger is only as new as each connection's last
    // fetch. Tolerant: a failure here must not fail the pull.
    let connections: FinancyConnectionSnapshot[] = [];
    try {
      const items = await this.paginate<FinancyConnection>(creds, '/v2/connections', { limit: String(FINANCY_PAGE_LIMIT) });
      connections = items.map(snapshotConnection).filter((c): c is FinancyConnectionSnapshot => c !== null);
    } catch (err) {
      if (err instanceof AdapterAuthError || err instanceof AdapterPlanError) throw err;
      logger.warn('[FinancyAdapter][pull] connections read failed (continuing)', { error: err instanceof Error ? err.message : String(err) });
    }


    logger.info('[FinancyAdapter][pull] pulled', {
      dateFrom,
      connections: connections.length,
      accounts: accountsById.size,
      transactions: txItems.length,
      rows: mapped.rows.length,
      skipped: mapped.skipped,
    });

    const nextCursor: FinancyCursor = { since: mapped.newestDate ?? today };
    return {
      rows: mapped.rows,
      cursor: nextCursor,
      config: {
        accounts: Array.from(accountsById.values()),
        accounts_fetched_at: this.now().toISOString(),
        connections,
        /** Latest day any connection holds data for; null when unknown. */
        data_through: connections.reduce<string | null>((m, c) => (c.dataThrough && (!m || c.dataThrough > m) ? c.dataThrough : m), null),
      },
    };
  }

  // ----- HTTP -----------------------------------------------------------

  private async paginate<T>(creds: FinancyCreds, path: string, params: Record<string, string>): Promise<T[]> {
    const items: T[] = [];
    let nextPage: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(creds, path, nextPage ? { ...params, nextPage } : params);
      const pageItems = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
      items.push(...(pageItems as T[]));
      const next = Array.isArray(body) ? undefined : body?.nextPage;
      if (typeof next !== 'string' || !next) break;
      nextPage = next;
    }
    return items;
  }

  private async get(creds: FinancyCreds, path: string, params: Record<string, string>): Promise<any> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    let res = await this.request(url, await this.token(creds));
    if (res.status === 401) {
      // The cached token may have been revoked early: re-mint once.
      this.tokens.delete(this.credHash(creds));
      res = await this.request(url, await this.token(creds));
      if (res.status === 401) throw new AdapterAuthError('Financy rejected the access token twice (401)');
    }
    if (res.status === 403) {
      const text = await res.text().catch(() => '');
      if (/NOT_AVAILABLE_ON_PLAN|plan/i.test(text)) throw new AdapterPlanError(`Financy: ${path} is not available on the current plan`);
      throw new AdapterAuthError(`Financy refused ${path} (403)`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Financy ${path} returned ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  private request(url: URL, token: string): Promise<Response> {
    return this.fetchImpl(url.toString(), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
  }

  private credHash(creds: FinancyCreds): string {
    return createHash('sha256').update(`${creds.user_id}|${creds.client_id}|${creds.client_secret}`, 'utf8').digest('hex');
  }

  private async token(creds: FinancyCreds): Promise<string> {
    const key = this.credHash(creds);
    const cached = this.tokens.get(key);
    const nowMs = this.now().getTime();
    if (cached && cached.expiresAt - FINANCY_TOKEN_SKEW_MS > nowMs) return cached.token;

    const res = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ userId: creds.user_id, clientId: creds.client_id, clientSecret: creds.client_secret }),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new AdapterAuthError(`Financy rejected the client credentials (${res.status})`);
    }
    if (!res.ok) throw new Error(`Financy /oauth/token returned ${res.status}`);
    const body = (await res.json()) as { accessToken?: unknown; expiresIn?: unknown };
    if (typeof body.accessToken !== 'string' || !body.accessToken) throw new AdapterAuthError('Financy /oauth/token returned no accessToken');

    let expiresAt = jwtExpiryMs(body.accessToken);
    if (expiresAt == null) {
      const ttl = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn : 3_600_000;
      // The API documents milliseconds; a small value would be seconds.
      expiresAt = nowMs + (ttl < 1_000_000 ? ttl * 1000 : ttl);
    }
    this.tokens.set(key, { token: body.accessToken, expiresAt });
    return body.accessToken;
  }
}
