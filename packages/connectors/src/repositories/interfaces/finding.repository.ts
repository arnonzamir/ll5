import type { FindingInput, FindingRecord } from '../../types.js';

/** Findings: what the reconciler / sync could not explain. Summaries carry no merchant text. */
export interface FindingRepository {
  /** Open a finding; an already-open finding with the same connector, kind and ref_id is returned instead. */
  open(input: FindingInput): Promise<FindingRecord>;
  resolve(id: string, note?: string): Promise<FindingRecord | null>;
  listOpen(connectorId?: string): Promise<FindingRecord[]>;
  /** Retention: delete resolved findings older than `months`. Returns the count. */
  deleteResolvedOlderThan(months: number): Promise<number>;
}
