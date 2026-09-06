/**
 * Zod schemas shared by the tools and the REST routes. Exported so the
 * refusal behaviour (strict rows, memo cap, ≤200 rows) is unit-testable
 * without a server.
 */
import { z } from 'zod';

export const LEDGER_ROW_KINDS = ['charge', 'refund', 'bill', 'appointment', 'notice', 'state_change'] as const;
export const EVENT_KINDS = ['charge', 'refund', 'bill', 'appointment', 'notice', 'state_change', 'otp', 'unknown'] as const;
export const EVENT_STATUSES = ['open', 'matched', 'expired'] as const;

const isoDate = z.string().datetime({ offset: true });
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO-4217 code, e.g. ILS');

/** One row for ingest_ledger_rows: strict — unknown keys and free text beyond `memo` are refused. */
export const LedgerRowSchema = z
  .object({
    external_id: z.string().min(1).max(200),
    kind: z.enum(LEDGER_ROW_KINDS),
    occurred_at: isoDate,
    posted_at: isoDate.optional(),
    amount: z.number().finite().optional(),
    currency: currency.optional(),
    merchant: z.string().min(1).max(120).optional(),
    memo: z.string().max(200).optional(),
    account_ref: z.string().max(32).optional(),
    category: z.string().max(60).optional(),
    installments: z.object({ number: z.number().int().min(1), total: z.number().int().min(1) }).strict().optional(),
  })
  .strict();

export const IngestLedgerRowsShape = {
  connector_id: z.string().min(1).max(50).describe('Catalog connector id, e.g. "clalit"'),
  rows: z.array(LedgerRowSchema).min(1).max(200).describe('Up to 200 rows; upserted on external_id'),
};
export const IngestLedgerRowsSchema = z.object(IngestLedgerRowsShape).strict();
export type IngestLedgerRowsInput = z.infer<typeof IngestLedgerRowsSchema>;

/** POST /api/events body — ConnectorEventInput from @ll5/shared, validated. */
export const ConnectorEventInputSchema = z
  .object({
    connector_id: z.string().min(1).max(50),
    kind: z.enum(EVENT_KINDS),
    occurred_at: isoDate,
    amount: z.number().finite().nullable().optional(),
    currency: currency.nullable().optional(),
    foreign: z.boolean().optional(),
    merchant: z.string().max(200).nullable().optional(),
    account_ref: z.string().max(32).nullable().optional(),
    dedupe_key: z.string().min(8).max(128),
    payload: z.record(z.unknown()),
    rule_hits: z.array(z.string().max(60)).max(20).optional(),
  })
  .strict();

export const ConnectorPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    schedule_minutes: z.number().int().min(5).max(10080).nullable().optional(),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

export const CredentialsBodySchema = z
  .object({
    auth_type: z.enum(['scraper_credentials', 'api_token', 'vault_browser_login', 'oauth']),
    secret: z.record(z.unknown()).refine((s) => Object.keys(s).length > 0, 'secret must not be empty'),
  })
  .strict();

/** POST /api/sync body. `scheduled: true` (gateway scheduler) engages the due gate; a manual sync ignores it. */
export const SyncBodySchema = z
  .object({
    connector_id: z.string().min(1).max(50),
    scheduled: z.boolean().optional(),
  })
  .strict();

export const QueryEventsShape = {
  connector_id: z.string().optional().describe('Catalog connector id'),
  since: isoDate.optional().describe('occurred_at >= (ISO-8601)'),
  until: isoDate.optional().describe('occurred_at < (ISO-8601)'),
  kind: z.enum(EVENT_KINDS).optional(),
  min_amount: z.number().optional(),
  status: z.enum(EVENT_STATUSES).optional(),
  limit: z.number().int().min(1).max(100).optional().describe('Default 50, max 100. The ~20 KB result cap applies on top.'),
  cursor: z.string().optional().describe('Opaque continuation cursor from a previous truncated response (next_cursor).'),
};

export const QueryLedgerShape = {
  connector_id: QueryEventsShape.connector_id,
  since: QueryEventsShape.since,
  until: QueryEventsShape.until,
  kind: z.enum(LEDGER_ROW_KINDS).optional(),
  min_amount: QueryEventsShape.min_amount,
  merchant: z.string().min(1).max(120).optional().describe('Case-insensitive substring over the decrypted page (ILIKE).'),
  limit: QueryEventsShape.limit,
  cursor: QueryEventsShape.cursor,
};
