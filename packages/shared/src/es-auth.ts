/**
 * ES fetch target helper.
 *
 * The raw-`fetch` ES writers (app-log, audit) historically passed credentials
 * INLINE in the URL (http://elastic:pw@es:9200). Node's `fetch` (undici) IGNORES
 * URL userinfo, so once ES auth was enabled (DECISION-011, 2026-06-05) every write
 * silently 401'd and was swallowed by the fire-and-forget catch — app_log + audit
 * ES indexing was dead for 8 days before anyone noticed (the `@elastic/elasticsearch`
 * client callers were fine; only the raw-fetch ones broke).
 *
 * This derives the base URL (creds stripped) + an explicit Basic auth header so the
 * raw-fetch writers authenticate correctly.
 */
let lastEsWarn = 0;

/** Surface a failed fire-and-forget ES write to stderr, throttled to once / 5 min.
 *  These writes are intentionally swallowed (must never break the app), but a fully
 *  broken write path should NOT be invisible — that's how app_log + audit silently
 *  died for 8 days after ES auth went on. */
export function warnEsWriteFailure(index: string, err: unknown): void {
  const now = Date.now();
  if (now - lastEsWarn < 5 * 60 * 1000) return;
  lastEsWarn = now;
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      action: 'es_write_failed',
      index,
      error: err instanceof Error ? err.message : String(err),
      timestamp: new Date().toISOString(),
    }) + '\n',
  );
}

export function esFetchTarget(url: string): { base: string; headers: Record<string, string> } {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const u = new URL(url);
    if (u.username) {
      const cred = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
      ).toString('base64');
      headers['Authorization'] = `Basic ${cred}`;
      return { base: `${u.protocol}//${u.host}`, headers };
    }
    return { base: `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, ''), headers };
  } catch {
    return { base: url.replace(/\/$/, ''), headers };
  }
}
