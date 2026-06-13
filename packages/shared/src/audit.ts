/**
 * Lightweight audit log writer for Elasticsearch.
 * Uses fetch() — no @elastic/elasticsearch dependency needed.
 * Each MCP imports this and calls logAudit() after mutations.
 */
import { getRequestContext } from './request-context.js';
import { esFetchTarget, warnEsWriteFailure } from './es-auth.js';

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

let esBase: string | null = null;
let esHeaders: Record<string, string> = { 'Content-Type': 'application/json' };

/** Initialize the audit logger with an ES URL. Call once at startup. */
export function initAudit(elasticsearchUrl: string): void {
  // Derive base + Basic-auth header (Node fetch ignores inline URL creds — es-auth.ts).
  const t = esFetchTarget(elasticsearchUrl);
  esBase = t.base;
  esHeaders = t.headers;
}

/** Write an audit entry. Fire-and-forget — never throws. */
export function logAudit(entry: AuditEntry): void {
  if (!esBase) return;

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

  void fetch(`${esBase}/${INDEX}/_doc`, {
    method: 'POST',
    headers: esHeaders,
    body: JSON.stringify(doc),
  }).catch((e) => {
    warnEsWriteFailure(INDEX, e);
  });
}

/** JSON.stringify that never throws (circular/odd values → a small placeholder). */
function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null';
  } catch {
    return JSON.stringify({ _unserializable: String(v).slice(0, 200) });
  }
}

/** A complete tool-call ledger row (DECISION-012 stage 3): the full input + output
 *  of one MCP tool call. `args`/`result` are stored as JSON strings (see below). */
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
  if (!esBase) return;

  const ctx = getRequestContext();
  const doc = {
    kind: 'tool_call' as const,
    user_id: entry.user_id ?? ctx?.userId,
    tool_name: entry.tool_name,
    // Stored as JSON STRINGS, not objects: an object would dynamic-map per-tool and
    // explode / type-conflict the index mapping. A string never conflicts and still
    // keeps everything; the cassette reader JSON.parses it back.
    args: entry.args === undefined ? null : safeJson(entry.args),
    result: entry.result === undefined ? null : safeJson(entry.result),
    duration_ms: entry.duration_ms,
    success: entry.success,
    error_message: entry.error_message,
    request_id: ctx?.requestId,
    session_id: ctx?.sessionId,
    trace_id: ctx?.traceId,
    timestamp: new Date().toISOString(),
  };

  void fetch(`${esBase}/${INDEX}/_doc`, {
    method: 'POST',
    headers: esHeaders,
    body: JSON.stringify(doc),
  }).catch((e) => {
    warnEsWriteFailure(INDEX, e);
  });
}
