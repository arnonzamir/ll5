/**
 * Per-request correlation context (DECISION-012, stage 2).
 *
 * One AsyncLocalStorage carries the ids that tie together every action a single
 * request produces — its app-log lines, audit/tool-ledger rows — so a concern can
 * be traced end to end. Replaces each MCP's bare `AsyncLocalStorage<string>` that
 * only held the userId.
 *
 *   - requestId : generated at request entry; always present. The span id.
 *   - userId    : the authenticated caller.
 *   - sessionId / traceId : propagated FROM the agent (stage 4) via request
 *                  headers; undefined until then.
 *
 * `logApp` / `logAudit` read this automatically, so callers don't thread ids.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

export interface RequestContext {
  userId: string;
  requestId: string;
  sessionId?: string;
  traceId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** A fresh span id. `req_` + 16 hex chars. */
export function newRequestId(): string {
  return 'req_' + randomBytes(8).toString('hex');
}

/** Run `fn` within a request context. `requestId` is generated if not supplied. */
export function runWithRequestContext<T>(
  ctx: { userId: string; requestId?: string; sessionId?: string; traceId?: string },
  fn: () => T,
): T {
  return store.run(
    {
      userId: ctx.userId,
      requestId: ctx.requestId ?? newRequestId(),
      sessionId: ctx.sessionId,
      traceId: ctx.traceId,
    },
    fn,
  );
}

export function getRequestContext(): RequestContext | undefined {
  return store.getStore();
}

/** The caller's userId, or undefined outside a request context. */
export function getContextUserId(): string | undefined {
  return store.getStore()?.userId;
}

export function getRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

export function getSessionId(): string | undefined {
  return store.getStore()?.sessionId;
}

export function getTraceId(): string | undefined {
  return store.getStore()?.traceId;
}
