import { describe, it, expect, beforeEach } from 'vitest';
import { reduceCall, isOnCall, applyCallEvent, getOnCallState, resetCallState, ON_CALL_STALE_MS } from '../utils/call-state.js';
import { callDocId, renderMissedCall } from '../processors/phone-call.js';
import { pickMode } from '../utils/delivery-mode.js';

const T0 = Date.UTC(2026, 8, 8, 9, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe('call state machine (pure)', () => {
  it('ringing → offhook → idle: one session, answered, duration from the event', () => {
    const r = reduceCall(null, { state: 'ringing', number: '+972501234567', contact_name: 'Dana', timestamp: iso(T0) }, T0);
    expect(r.record).toMatchObject({ phase: 'ringing', direction: 'incoming', answered: false, started_at: iso(T0) });
    expect(r.missed).toBe(false);
    expect(isOnCall(r.next, T0)).toBe(false);

    const o = reduceCall(r.next, { state: 'offhook', timestamp: iso(T0 + 5_000) }, T0 + 5_000);
    expect(o.record).toMatchObject({ phase: 'offhook', number: '+972501234567', contact_name: 'Dana', direction: 'incoming', answered: true, started_at: iso(T0) });
    expect(isOnCall(o.next, T0 + 60_000)).toBe(true);

    const i = reduceCall(o.next, { state: 'idle', duration_s: 95, call_log_id: '4711', timestamp: iso(T0 + 100_000) }, T0 + 100_000);
    expect(i.record).toMatchObject({ phase: 'idle', duration_s: 95, call_log_id: '4711', direction: 'incoming', ended_at: iso(T0 + 100_000) });
    expect(i.missed).toBe(false);
    expect(i.next).toBeNull();
  });

  it('missed: explicit direction on idle, or ringing → idle with no offhook', () => {
    const r = reduceCall(null, { state: 'ringing', number: '+972501234567', timestamp: iso(T0) }, T0);
    const explicit = reduceCall(r.next, { state: 'idle', direction: 'missed', timestamp: iso(T0 + 20_000) }, T0 + 20_000);
    expect(explicit.missed).toBe(true);
    expect(explicit.record?.direction).toBe('missed');
    expect(explicit.record?.answered).toBe(false);

    const inferred = reduceCall(r.next, { state: 'idle', timestamp: iso(T0 + 20_000) }, T0 + 20_000);
    expect(inferred.missed).toBe(true);
    expect(inferred.record?.direction).toBe('missed');
  });

  it('offhook with no prior ringing is an outgoing call; duration derived when the phone sends none', () => {
    const o = reduceCall(null, { state: 'offhook', number: '+972501111111', timestamp: iso(T0) }, T0);
    expect(o.record).toMatchObject({ phase: 'offhook', direction: 'outgoing', answered: true });
    const i = reduceCall(o.next, { state: 'idle', timestamp: iso(T0 + 61_000) }, T0 + 61_000);
    expect(i.record).toMatchObject({ direction: 'outgoing', duration_s: 61 });
    expect(i.missed).toBe(false);
  });

  it('a stale offhook (> 3 h) is no longer on a call and is discarded by the next event', () => {
    const o = reduceCall(null, { state: 'offhook', number: '+972501111111', timestamp: iso(T0) }, T0);
    expect(isOnCall(o.next, T0 + ON_CALL_STALE_MS - 1)).toBe(true);
    expect(isOnCall(o.next, T0 + ON_CALL_STALE_MS + 1)).toBe(false);
    const later = T0 + ON_CALL_STALE_MS + 60_000;
    const r = reduceCall(o.next, { state: 'ringing', number: '+972502222222', timestamp: iso(later) }, later);
    expect(r.staleReset).toBe(true);
    expect(r.record?.number).toBe('+972502222222');
    expect(r.record?.started_at).toBe(iso(later));
  });

  it('an idle with nothing in flight and nothing identifying a call records nothing', () => {
    const i = reduceCall(null, { state: 'idle', timestamp: iso(T0) }, T0);
    expect(i.record).toBeNull();
    // but a lone idle carrying a call-log row is still a call
    const j = reduceCall(null, { state: 'idle', number: '+972501111111', direction: 'missed', call_log_id: '9', timestamp: iso(T0) }, T0);
    expect(j.record).toMatchObject({ direction: 'missed', call_log_id: '9' });
    expect(j.missed).toBe(true);
  });
});

describe('call doc id (upsert key)', () => {
  it('is stable across ringing → offhook → idle (started_at + number) and differs per tenant', () => {
    const r = reduceCall(null, { state: 'ringing', number: '+972501234567', timestamp: iso(T0) }, T0);
    const o = reduceCall(r.next, { state: 'offhook', timestamp: iso(T0 + 5_000) }, T0 + 5_000);
    const i = reduceCall(o.next, { state: 'idle', call_log_id: '4711', timestamp: iso(T0 + 100_000) }, T0 + 100_000);
    const id = callDocId('u1', r.record!);
    expect(callDocId('u1', o.record!)).toBe(id);
    expect(callDocId('u1', i.record!)).toBe(id);
    expect(callDocId('u2', i.record!)).not.toBe(id);
  });
  it('falls back to call_log_id when there is no number', () => {
    const a = callDocId('u1', { call_log_id: '77', started_at: iso(T0), number: null });
    const b = callDocId('u1', { call_log_id: '77', started_at: iso(T0 + 1), number: null });
    expect(a).toBe(b);
  });
});

describe('registry + delivery mode', () => {
  beforeEach(() => resetCallState());

  it('offhook → on_call until idle; the mode sits between driving and meeting', () => {
    expect(getOnCallState('u1', T0)).toBeNull();
    applyCallEvent('u1', { state: 'ringing', number: '+972501234567', contact_name: 'Dana', timestamp: iso(T0) }, T0);
    expect(getOnCallState('u1', T0)).toBeNull(); // ringing is not on a call
    applyCallEvent('u1', { state: 'offhook', timestamp: iso(T0 + 3_000) }, T0 + 3_000);
    expect(getOnCallState('u1', T0 + 4_000)).toEqual({ since: iso(T0), number: '+972501234567', contact_name: 'Dana' });
    expect(getOnCallState('u2', T0 + 4_000)).toBeNull();
    applyCallEvent('u1', { state: 'idle', timestamp: iso(T0 + 90_000) }, T0 + 90_000);
    expect(getOnCallState('u1', T0 + 91_000)).toBeNull();

    const base = { quiet: false, asleep: false, sick: false };
    expect(pickMode({ ...base, driving: true, meeting: true, onCall: true }).mode).toBe('driving');
    const onCall = pickMode({ ...base, driving: false, meeting: true, onCall: true });
    expect(onCall.mode).toBe('on_call');
    expect(onCall.reasons).toContain('on a phone call');
    expect(pickMode({ ...base, driving: false, meeting: true, onCall: false }).mode).toBe('meeting');
    expect(pickMode({ quiet: true, asleep: false, sick: false, driving: false, meeting: false, onCall: true }).mode).toBe('quiet_hours');
  });

  it('stale offhook resets: no on_call after 3 h without an idle', () => {
    applyCallEvent('u1', { state: 'offhook', number: '+972501111111', timestamp: iso(T0) }, T0);
    expect(getOnCallState('u1', T0 + ON_CALL_STALE_MS + 1)).toBeNull();
  });
});

describe('missed-call line', () => {
  it('names the contact with the number, else the number, in local time', () => {
    expect(renderMissedCall('Dana', '+972501234567', '2026-09-08T09:05:00.000Z', 'Asia/Jerusalem')).toBe('[Call] Missed call from Dana (+972501234567) at 12:05');
    expect(renderMissedCall(null, '+972501234567', '2026-09-08T09:05:00.000Z', 'Asia/Jerusalem')).toBe('[Call] Missed call from +972501234567 at 12:05');
    expect(renderMissedCall(null, null, '2026-09-08T09:05:00.000Z', 'Asia/Jerusalem')).toBe('[Call] Missed call from unknown number at 12:05');
  });
});
