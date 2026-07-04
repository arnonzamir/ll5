/**
 * Redaction helpers (DECISION-022 §5).
 *
 * The hard rule: credential material must never leave this process in any
 * return value, log line, or thrown error. Errors thrown by playwright /
 * fetch / bw can embed page content or request bodies, so every error that
 * crosses a tool boundary is passed through sanitizeError() first.
 */

const MAX_ERROR_LEN = 300;

/**
 * Produce a safe, single-line error message: any occurrence of a known
 * secret value is replaced, and the message is truncated. Stack traces are
 * dropped entirely.
 */
export function sanitizeError(err: unknown, secrets: Array<string | undefined | null>): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue;
    // split/join instead of RegExp — secret values must not be regex-interpreted.
    message = message.split(secret).join('[redacted]');
  }
  message = message.replace(/\s+/g, ' ').trim();
  if (message.length > MAX_ERROR_LEN) message = message.slice(0, MAX_ERROR_LEN) + '…';
  return message;
}

/**
 * Assert (defense in depth) that a tool result object contains none of the
 * given secret values anywhere in its JSON serialization. Returns a cleaned
 * copy — if a secret somehow leaked into the payload, the whole payload is
 * replaced with a generic error rather than shipped.
 */
export function assertNoSecrets<T>(result: T, secrets: Array<string | undefined | null>): T | { status: 'failed'; reason: 'redaction_violation' } {
  const json = JSON.stringify(result);
  for (const secret of secrets) {
    if (!secret || secret.length === 0) continue;
    if (json.includes(secret)) {
      return { status: 'failed', reason: 'redaction_violation' };
    }
  }
  return result;
}
