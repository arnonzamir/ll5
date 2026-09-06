import type { ConnectorAuthType } from '@ll5/shared';
import type { LedgerRowInput } from '../types.js';

export interface PullResult {
  rows: LedgerRowInput[];
  /** Opaque, persisted on the connectors row and handed back on the next pull. */
  cursor: unknown;
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
 * pull itself (scraper child process, HA REST API). Read-only towards the
 * outside world, always. Skill-driven portals (Clalit, municipality) have no
 * adapter — their rows arrive through `ingest_ledger_rows`.
 */
export interface ConnectorAdapter {
  readonly id: string;
  readonly authType: ConnectorAuthType;
  pull(creds: Record<string, unknown>, cursor: unknown, ctx: PullContext): Promise<PullResult>;
}
