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

/** A complete tool-call ledger row (DECISION-012 stage 3): the full input + output
 *  of one MCP tool call. `args`/`result` are stored non-indexed (mapping
 *  `enabled:false`) so keeping everything doesn't explode the index mapping. */
export interface ToolCallAuditEntry {
  user_id?: string;
  tool_name: string;
  args?: unknown;
  result?: unknown;
  duration_ms?: number;
  success: boolean;
  error_message?: string;
}

/** Write a `kind:'tool_call'` row with the full I/O to the same audit index.
 *  Fire-and-forget; correlation ids + user fall back to the request context. */
export function logToolCall(entry: ToolCallAuditEntry): void {
  if (!esUrl) return;

  const ctx = getRequestContext();
  const doc = {
    kind: 'tool_call' as const,
    user_id: entry.user_id ?? ctx?.userId,
    tool_name: entry.tool_name,
    args: entry.args ?? null,
    result: entry.result ?? null,
    duration_ms: entry.duration_ms,
    success: entry.success,
    error_message: entry.error_message,
    request_id: ctx?.requestId,
    session_id: ctx?.sessionId,
    trace_id: ctx?.traceId,
    timestamp: new Date().toISOString(),
  };

  void fetch(`${esUrl}/${INDEX}/_doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  }).catch(() => {
    // Silent — the ledger is best-effort; a write failure must not affect the call.
  });
}
