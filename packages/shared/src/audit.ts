/**
 * Lightweight audit log writer for Elasticsearch.
 * Uses fetch() — no @elastic/elasticsearch dependency needed.
 * Each MCP imports this and calls logAudit() after mutations.
 */
import { getRequestContext } from './request-context.js';

export interface AuditEntry {
  user_id: string;
  username?: string;
  source: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata?: Record<string, unknown>;
  /** Correlation ids (DECISION-012) — auto-filled from the request context. */
  request_id?: string;
  session_id?: string;
  trace_id?: string;
}

const INDEX = 'll5_audit_log';

let esUrl: string | null = null;

/** Initialize the audit logger with an ES URL. Call once at startup. */
export function initAudit(elasticsearchUrl: string): void {
  esUrl = elasticsearchUrl.replace(/\/$/, '');
}

/** Write an audit entry. Fire-and-forget — never throws. */
export function logAudit(entry: AuditEntry): void {
  if (!esUrl) return;

  const ctx = getRequestContext();
  const doc = {
    // 'mutation' = semantic audit rows; stage 3 adds 'tool_call' ledger rows.
    kind: 'mutation' as const,
    ...entry,
    request_id: entry.request_id ?? ctx?.requestId,
    session_id: entry.session_id ?? ctx?.sessionId,
    trace_id: entry.trace_id ?? ctx?.traceId,
    timestamp: new Date().toISOString(),
  };

  void fetch(`${esUrl}/${INDEX}/_doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  }).catch(() => {
    // Silent — audit is best-effort
  });
}
