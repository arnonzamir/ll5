import type { ConnectorAuthType } from '@ll5/shared';
import type { LedgerRowInput } from '../types.js';

export interface PullResult {
  rows: LedgerRowInput[];
  /** Opaque, persisted on the connectors row and handed back on the next pull. */
  cursor: unknown;
  /**
   * Optional patch merged (shallow) into the connector row's `config` after a
   * successful pull — e.g. a masked account/balance snapshot for the digest.
   * Never secrets, never owner identifiers.
   */
  config?: Record<string, unknown>;
}

export interface PullContext {
  /**
   * Resolves with an OTP the user submitted through `submit_otp` (60 s TTL), or
   * null when none arrived within `timeoutMs`. Adapters for sources that demand
   * a one-time code call this mid-pull.
   */
  waitForOtp: (timeoutMs?: number) => Promise<string | null>;
}

/**
 * A ledger adapter: one per connector that has a batch feed the service can
 * pull itself (scraper child process, HA REST API, an aggregator's read API).
 * Read-only towards the outside world, always. Event-only connectors (cards,
 * bank, Clalit, IEC, water, PayBox) have no adapter; no scrapers, no portal
 * automation (DECISION-032 amendment). `ingest_ledger_rows` exists for rows an
 * agent skill or a manual import hands over.
 */
export interface ConnectorAdapter {
  readonly id: string;
  readonly authType: ConnectorAuthType;
  pull(creds: Record<string, unknown>, cursor: unknown, ctx: PullContext): Promise<PullResult>;
}
