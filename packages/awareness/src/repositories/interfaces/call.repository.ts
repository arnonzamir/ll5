/**
 * Phone calls (ll5_awareness_calls, one doc per call, written by the gateway's
 * processors/phone-call.ts). Read-only from the MCP side.
 */
export type CallDirection = 'incoming' | 'outgoing' | 'missed';
export type CallState = 'ringing' | 'offhook' | 'idle';

export interface CallRecord {
  id: string;
  state: CallState;
  direction: CallDirection | null;
  number: string | null;
  contact_name: string | null;
  person_id: string | null;
  known_contact: boolean;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  call_log_id: string | null;
  updated_at: string;
}

export interface CallQueryParams {
  since?: string;
  until?: string;
  direction?: CallDirection;
  number?: string;
  /** Fuzzy match on contact_name. */
  contact?: string;
  limit?: number;
  offset?: number;
}

export interface CallRepository {
  /** Newest first by started_at. */
  query(userId: string, params: CallQueryParams): Promise<CallRecord[]>;
  /** The call in progress: latest doc in state `offhook` updated within `maxAgeMs`, else null. */
  getActive(userId: string, now: Date, maxAgeMs: number): Promise<CallRecord | null>;
  /** Missed calls since `since`, newest first, at most `limit`. */
  recentMissed(userId: string, since: string, limit: number): Promise<CallRecord[]>;
}
