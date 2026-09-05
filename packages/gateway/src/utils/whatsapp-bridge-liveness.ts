/**
 * WhatsApp bridge liveness — ground truth for "is the Evolution → gateway path
 * alive", independent of whether anyone is messaging (ISS-013, 2026-09-05).
 *
 * The flow monitor used to infer an outage from message silence alone. Over 14
 * days it fired 14 times, every one between 01:07 and 05:21 local, when the
 * inbox is simply empty — and Evolution showed no fault. The bridge itself is
 * rarely silent even at night: MESSAGES_UPDATE (read receipts), CHATS_UPDATE
 * and CONNECTION_UPDATE keep arriving. Every event that reaches
 * dispatchEvolutionEvent() is recorded here, so the monitor can tell "quiet
 * inbox on a live bridge" from "bridge dead".
 *
 * In-memory by design: a gateway restart resets it and the monitor falls back
 * to its silence rules until the first event lands (seconds to minutes).
 */
export interface BridgeLiveness {
  /** Any Evolution event for this user (message, receipt, chat, lifecycle). */
  last_event_at: string | null;
  last_event: string | null;
  /** Last messages.upsert specifically. */
  last_message_event_at: string | null;
  /** Last connection.update state Evolution reported, and when. */
  connection_state: 'open' | 'connecting' | 'close' | null;
  connection_state_at: string | null;
}

const STATE = new Map<string, BridgeLiveness>();

function entry(userId: string): BridgeLiveness {
  let e = STATE.get(userId);
  if (!e) {
    e = { last_event_at: null, last_event: null, last_message_event_at: null, connection_state: null, connection_state_at: null };
    STATE.set(userId, e);
  }
  return e;
}

export function recordBridgeEvent(userId: string, event: string | undefined, data: unknown, now = new Date()): void {
  if (!userId || !event) return;
  const e = entry(userId);
  const ts = now.toISOString();
  e.last_event_at = ts;
  e.last_event = event;
  if (event === 'messages.upsert') e.last_message_event_at = ts;
  if (event === 'connection.update') {
    const state = (data as { state?: string } | undefined)?.state;
    if (state === 'open' || state === 'connecting' || state === 'close') {
      e.connection_state = state;
      e.connection_state_at = ts;
    }
  }
}

export function getBridgeLiveness(userId: string): BridgeLiveness | null {
  return STATE.get(userId) ?? null;
}

/** Test hook. */
export function resetBridgeLiveness(): void {
  STATE.clear();
}
