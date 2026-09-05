import { describe, it, expect } from 'vitest';
import {
  evaluateWhatsAppFlow,
  isQuietHour,
  BRIDGE_FRESH_MINUTES,
  CONNECTION_CLOSE_GRACE_MINUTES,
  type FlowInput,
} from '../scheduler/whatsapp-flow-monitor.js';
import { recordBridgeEvent, getBridgeLiveness, resetBridgeLiveness } from '../utils/whatsapp-bridge-liveness.js';

const policy = { stalenessHours: 2, fastStaleMinutes: 45, otherChannelFreshMinutes: 20 };
const base: FlowInput = {
  messageAgeMinutes: 10, otherChannelAgeMinutes: null, bridgeEventAgeMinutes: 5,
  connectionState: 'open', connectionStateAgeMinutes: 600, quietHour: false,
};

describe('evaluateWhatsAppFlow — ISS-013: silence is not an outage at night', () => {
  it('3h of silence at a quiet hour with the bridge alive: not stale (the 14-nights-in-14 false positive)', () => {
    expect(evaluateWhatsAppFlow({ ...base, messageAgeMinutes: 180, bridgeEventAgeMinutes: 12, quietHour: true }, policy))
      .toEqual({ stale: false, reason: 'bridge_alive' });
  });

  it('3h of silence at a quiet hour with no bridge data (gateway just restarted): still not stale', () => {
    expect(evaluateWhatsAppFlow({ ...base, messageAgeMinutes: 180, bridgeEventAgeMinutes: null, quietHour: true }, policy))
      .toEqual({ stale: false, reason: 'quiet_hour' });
  });

  it('phone/slack noise at night (divergence rule) no longer trips at a quiet hour', () => {
    expect(evaluateWhatsAppFlow({ ...base, messageAgeMinutes: 51, otherChannelAgeMinutes: 5, bridgeEventAgeMinutes: null, quietHour: true }, policy).stale)
      .toBe(false);
  });

  it('3h of silence during a busy hour: stale (flat_silence) — the real daytime anomaly is kept', () => {
    expect(evaluateWhatsAppFlow({ ...base, messageAgeMinutes: 180, bridgeEventAgeMinutes: 200, quietHour: false }, policy))
      .toEqual({ stale: true, reason: 'flat_silence' });
  });

  it('daytime divergence (WhatsApp silent 50m, slack 5m ago) is stale unless the bridge is demonstrably alive', () => {
    const d = { ...base, messageAgeMinutes: 50, otherChannelAgeMinutes: 5, quietHour: false };
    expect(evaluateWhatsAppFlow({ ...d, bridgeEventAgeMinutes: BRIDGE_FRESH_MINUTES + 30 }, policy)).toEqual({ stale: true, reason: 'divergence' });
    expect(evaluateWhatsAppFlow({ ...d, bridgeEventAgeMinutes: 3 }, policy)).toEqual({ stale: false, reason: 'bridge_alive' });
  });

  it('Evolution connection.update state=close past the grace period is stale at ANY hour, even with recent events', () => {
    expect(evaluateWhatsAppFlow({ ...base, messageAgeMinutes: 5, bridgeEventAgeMinutes: 1, quietHour: true, connectionState: 'close', connectionStateAgeMinutes: CONNECTION_CLOSE_GRACE_MINUTES + 1 }, policy))
      .toEqual({ stale: true, reason: 'connection_closed' });
    // inside the grace period Baileys is still reconnecting
    expect(evaluateWhatsAppFlow({ ...base, connectionState: 'close', connectionStateAgeMinutes: 1 }, policy).stale).toBe(false);
  });

  it('flowing inbox: not stale', () => {
    expect(evaluateWhatsAppFlow(base, policy)).toEqual({ stale: false, reason: 'flowing' });
  });
});

describe('isQuietHour', () => {
  const bucket = (day: number, hour: number, n: number) => ({ key_as_string: `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000+03:00`, doc_count: n });
  it('quiet when the same local hour was empty on >= 5 of 14 days; busy otherwise; never quiet on thin history', () => {
    const night = Array.from({ length: 14 }, (_, d) => bucket(d + 1, 3, d < 8 ? 0 : 2));
    const day = Array.from({ length: 14 }, (_, d) => bucket(d + 1, 12, 40 + d));
    expect(isQuietHour(night, 3)).toBe(true);
    expect(isQuietHour(day, 12)).toBe(false);
    expect(isQuietHour(night.slice(0, 5), 3)).toBe(false);
  });
});

describe('recordBridgeEvent', () => {
  it('records any event as liveness, messages.upsert separately, and the connection state', () => {
    resetBridgeLiveness();
    const t0 = new Date('2026-09-05T02:00:00Z');
    recordBridgeEvent('u1', 'messages.update', {}, t0);
    recordBridgeEvent('u1', 'connection.update', { state: 'close' }, new Date(t0.getTime() + 1000));
    let l = getBridgeLiveness('u1')!;
    expect(l.last_event).toBe('connection.update');
    expect(l.last_message_event_at).toBeNull();
    expect(l.connection_state).toBe('close');
    recordBridgeEvent('u1', 'messages.upsert', {}, new Date(t0.getTime() + 2000));
    l = getBridgeLiveness('u1')!;
    expect(l.last_message_event_at).toBe('2026-09-05T02:00:02.000Z');
    expect(l.connection_state).toBe('close'); // unchanged by a message
    expect(getBridgeLiveness('nobody')).toBeNull();
  });
});
