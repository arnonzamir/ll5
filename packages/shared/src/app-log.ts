/**
 * Structured application logger that writes to Elasticsearch.
 * Replaces console.log/warn/error across all services.
 * Fire-and-forget — never throws, never blocks.
 */
import { getRequestContext } from './request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppLogEntry {
  service: string;
  level: LogLevel;
  action: string;
  message: string;
  user_id?: string;
  tool_name?: string;
  duration_ms?: number;
  success?: boolean;
  error_message?: string;
  metadata?: Record<string, unknown>;
  /** Correlation ids (DECISION-012) — auto-filled from the request context. */
  request_id?: string;
  session_id?: string;
  trace_id?: string;
}

const INDEX = 'll5_app_log';
const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let esUrl: string | null = null;
let serviceName: string = 'unknown';
let minLevel: LogLevel = 'info';

/** Initialize the app logger. Call once at startup. */
export function initAppLog(config: {
  elasticsearchUrl: string;
  service: string;
  level?: LogLevel;
}): void {
  esUrl = config.elasticsearchUrl.replace(/\/$/, '');
  serviceName = config.service;
  minLevel = config.level ?? 'info';
}

/** Write a structured log entry to ES. Also writes to stdout for Docker log capture. */
export function logApp(entry: Omit<AppLogEntry, 'service'>): void {
  const ctx = getRequestContext();
  const fullEntry: AppLogEntry & { timestamp: string } = {
    ...entry,
    // Auto-fill correlation ids from the request context (explicit values win).
    request_id: entry.request_id ?? ctx?.requestId,
    session_id: entry.session_id ?? ctx?.sessionId,
    trace_id: entry.trace_id ?? ctx?.traceId,
    service: serviceName,
    timestamp: new Date().toISOString(),
  };

  // Always write to stdout as structured JSON (Docker/fallback)
  if (LOG_LEVELS[entry.level] >= LOG_LEVELS[minLevel]) {
    const { metadata, ...logLine } = fullEntry;
    const line = metadata && Object.keys(metadata).length > 0
      ? { ...logLine, ...metadata }
      : logLine;
    process.stdout.write(JSON.stringify(line) + '\n');
  }

  // Write to ES if configured
  if (!esUrl) return;
  if (LOG_LEVELS[entry.level] < LOG_LEVELS[minLevel]) return;

  void fetch(`${esUrl}/${INDEX}/_doc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fullEntry),
  }).catch(() => {
    // Silent — logging should never break the app
  });
}

/** Convenience loggers */
export const appLog = {
  debug: (action: string, message: string, extra?: Partial<AppLogEntry>) =>
    logApp({ level: 'debug', action, message, ...extra }),
  info: (action: string, message: string, extra?: Partial<AppLogEntry>) =>
    logApp({ level: 'info', action, message, ...extra }),
  warn: (action: string, message: string, extra?: Partial<AppLogEntry>) =>
    logApp({ level: 'warn', action, message, ...extra }),
  error: (action: string, message: string, extra?: Partial<AppLogEntry>) =>
    logApp({ level: 'error', action, message, ...extra }),
};
