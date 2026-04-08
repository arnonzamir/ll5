/**
 * Lightweight audit log writer for Elasticsearch.
 * Uses fetch() — no @elastic/elasticsearch dependency needed.
 * Each MCP imports this and calls logAudit() after mutations.
 */

export interface AuditEntry {
  user_id: string;
  username?: string;
  source: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  metadata?: Record<string, unknown>;
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

  const doc = {
    ...entry,
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
