/**
 * Connector event liveness — "when did this gateway last receive a phone
 * event for connector X" per user. Feeds the `connector.<id>.events`
 * staleness checks in scheduler/anomaly-monitor.ts.
 *
 * In-memory by design (same idiom as utils/whatsapp-bridge-liveness.ts): a
 * gateway restart forgets everything, the first ticks report null, and the
 * check treats null as "unknown, do not fire" — it re-arms on the first event.
 */
const LAST = new Map<string, number>();

function k(userId: string, connectorId: string): string { return `${userId}:${connectorId}`; }

export function recordConnectorEvent(userId: string, connectorId: string, now = Date.now()): void {
  if (!userId || !connectorId) return;
  LAST.set(k(userId, connectorId), now);
}

/** ISO of the last event, or null when none has been seen since the process started. */
export function getConnectorLastEventAt(userId: string, connectorId: string): string | null {
  const t = LAST.get(k(userId, connectorId));
  return t === undefined ? null : new Date(t).toISOString();
}

/** Minutes since the last event, or null when unknown. */
export function connectorEventAgeMinutes(userId: string, connectorId: string, now = Date.now()): number | null {
  const t = LAST.get(k(userId, connectorId));
  return t === undefined ? null : Math.max(0, (now - t) / 60_000);
}

/** Snapshot for /admin/health. */
export function getConnectorLiveness(userId: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, t] of LAST) {
    if (key.startsWith(`${userId}:`)) out[key.slice(userId.length + 1)] = new Date(t).toISOString();
  }
  return out;
}

/** Test hook. */
export function resetConnectorLiveness(): void { LAST.clear(); }
