import { describe, it, expect } from 'vitest';
import {
  validateDeliveryBlock, planRungs, nextRung, futureText, subjectLeads, LEVEL_BY_STAKES, modalityForLevel,
} from '../utils/delivery-contract.js';
import type { PlannedRung } from '../utils/delivery-contract.js';

// DECISION-034 Phase 1 — pure contract logic (DECISION-029: tables, no mocks).

const NOW = new Date('2026-09-07T06:00:00Z'); // 09:00 Asia/Jerusalem
const TZ = 'Asia/Jerusalem';
const plus = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

describe('validateDeliveryBlock', () => {
  const base = { content: 'Card pickup, 17 HaNadiv — the branch closes at 13:00.', proactive: true, now: NOW };

  const cases: Array<[string, Parameters<typeof validateDeliveryBlock>[0], string | null]> = [
    ['no block on a proactive message', { ...base, delivery: undefined }, 'delivery.class is required'],
    ['no block on a reply is fine', { ...base, proactive: false, delivery: undefined }, null],
    ['unknown class', { ...base, delivery: { class: 'urgent' } }, 'delivery.class must be one of'],
    ['fyi needs nothing else', { ...base, delivery: { class: 'fyi' } }, null],
    ['needs-you without subject', { ...base, delivery: { class: 'needs-you', due_at: plus(60) } }, 'delivery.subject is required'],
    ['needs-you without due', { ...base, delivery: { class: 'needs-you', subject: 'Card pickup' } }, 'delivery.due_at is required on a needs-you'],
    ['do-by without due', { ...base, delivery: { class: 'do-by', subject: 'Card pickup' } }, 'a do-by needs a deadline'],
    ['due in the past', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(-5) } }, 'must be in the future'],
    ['due beyond 14 days', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(15 * 24 * 60) } }, 'at most 14 days'],
    ['subject not first', { ...base, delivery: { class: 'do-by', subject: 'branch closes at 13:00 tomorrow morning', due_at: plus(60) } }, 'must open the message'],
    ['subject too long', { ...base, delivery: { class: 'do-by', subject: 'x'.repeat(41), due_at: plus(60) } }, 'at most 40 characters'],
    ['do-by with ack_required false', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), ack_required: false } }, 'requires acknowledgement'],
    ['bad stakes', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), stakes: 'huge' } }, 'delivery.stakes must be'],
    ['bad escalation preset', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), escalation: 'loud' } }, 'delivery.escalation must be'],
    ['do-by with escalation none', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), escalation: 'none' } }, "'none' is not allowed on a do-by"],
    ['bad escalation step', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), escalation: [{ offset_minutes: -10, rung: 'shout' }] } }, 'delivery.escalation steps must be'],
    ['valid do-by', { ...base, delivery: { class: 'do-by', subject: 'Card pickup', due_at: plus(60), stakes: 'medium' } }, null],
    ['valid needs-you, Hebrew subject, case-folded and punctuation-free', {
      ...base, content: 'איסוף כרטיס, הנדיב 17 — הסניף נסגר ב-13:00', delivery: { class: 'needs-you', subject: 'איסוף כרטיס הנדיב 17', due_at: plus(60) },
    }, null],
  ];

  for (const [name, input, expectedError] of cases) {
    it(`${expectedError ? 'refuses' : 'accepts'}: ${name}`, () => {
      const r = validateDeliveryBlock(input);
      if (expectedError) {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain(expectedError);
      } else {
        expect(r.ok).toBe(true);
      }
    });
  }

  it('normalises: do-by defaults to ack_required + standard ladder + medium stakes; fyi carries none of it', () => {
    const r = validateDeliveryBlock({ ...base, delivery: { class: 'do-by', subject: 'card pickup', due_at: plus(60) } });
    expect(r.ok && r.delivery).toEqual({
      class: 'do-by', subject: 'card pickup', due_at: plus(60), stakes: 'medium', ack_required: true, escalation: 'standard',
    });
    const f = validateDeliveryBlock({ ...base, delivery: { class: 'fyi', escalation: 'standard' } });
    expect(f.ok && f.delivery).toEqual({ class: 'fyi', subject: null, due_at: null, stakes: null, ack_required: false, escalation: 'none' });
    expect(f.ok && f.notes[0]).toContain('escalation ignored');
  });

  it("downgrades stakes 'critical' to 'high' unless the message itself is notification_level critical (DECISION-030)", () => {
    const d = { class: 'do-by', subject: 'Card pickup', due_at: plus(60), stakes: 'critical' };
    const down = validateDeliveryBlock({ ...base, delivery: d });
    expect(down.ok && down.delivery?.stakes).toBe('high');
    expect(down.ok && down.notes[0]).toContain("stakes downgraded to 'high'");
    const kept = validateDeliveryBlock({ ...base, delivery: d, notification_level: 'critical' });
    expect(kept.ok && kept.delivery?.stakes).toBe('critical');
    expect(kept.ok && kept.notes).toEqual([]);
  });

  it('accepts an explicit escalation array in the habits shape with rung instead of level', () => {
    const r = validateDeliveryBlock({ ...base, delivery: {
      class: 'do-by', subject: 'Card pickup', due_at: plus(60), escalation: [{ offset_minutes: -30, rung: 'repush' }, { offset_minutes: -5, rung: 'alarm' }],
    } });
    expect(r.ok && r.delivery?.escalation).toEqual([{ offset_minutes: -30, rung: 'repush' }, { offset_minutes: -5, rung: 'alarm' }]);
  });
});

describe('subjectLeads', () => {
  it('matches within the first 80 characters only', () => {
    expect(subjectLeads('Card pickup', 'Card pickup, 17 HaNadiv — closes at 13:00')).toBe(true);
    expect(subjectLeads('Card pickup', `${'x'.repeat(80)} Card pickup`)).toBe(false);
    expect(subjectLeads('CARD PICKUP 17 HANADIV', 'card pickup, 17 hanadiv')).toBe(true);
  });
});

describe('level map', () => {
  it('low → silent, medium → notify, high → alert, critical → critical; modality follows', () => {
    expect(LEVEL_BY_STAKES).toEqual({ low: 'silent', medium: 'notify', high: 'alert', critical: 'critical' });
    expect(modalityForLevel('silent')).toBe('push_silent');
    expect(modalityForLevel('notify')).toBe('push_notify');
    expect(modalityForLevel('alert')).toBe('push_alert');
    expect(modalityForLevel('critical')).toBe('push_alarm');
    expect(modalityForLevel(null)).toBe('chat');
  });
});

describe('planRungs', () => {
  const sent = NOW;
  const due = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const times = (r: PlannedRung[]) => r.map((x) => `${x.rung}@+${Math.round((Date.parse(x.at) - NOW.getTime()) / 60_000)}`);

  const cases: Array<[string, Parameters<typeof planRungs>[0], number, string[]]> = [
    ['standard, due in 2 h: re-push at due−45, alarm at due−15, reach at due−5', 'standard', 120, ['repush@+75', 'alarm@+105', 'reach@+115']],
    ['standard, due in 30 min: re-push floors at send+10, alarm/reach keep their offsets', 'standard', 30, ['repush@+10', 'alarm@+15', 'reach@+25']],
    ['standard, due in 12 min: nothing earlier than the re-push, times never decrease', 'standard', 12, ['repush@+10', 'alarm@+10', 'reach@+10']],
    ['gentle: re-push only', 'gentle', 120, ['repush@+75']],
    ['none: empty', 'none', 120, []],
    ['explicit array: offsets relative to due, sorted by rung order', [{ offset_minutes: -5, rung: 'alarm' }, { offset_minutes: -60, rung: 'repush' }], 120, ['repush@+60', 'alarm@+115']],
    ['explicit array before send is clamped to send', [{ offset_minutes: -180, rung: 'repush' }], 120, ['repush@+0']],
  ];
  for (const [name, spec, dueMin, expected] of cases) {
    it(name, () => {
      expect(times(planRungs(spec, sent, due(dueMin)))).toEqual(expected);
    });
  }

  it('rung levels are alert, lifted to critical for critical stakes', () => {
    expect(planRungs('standard', sent, due(120)).map((r) => r.level)).toEqual(['alert', 'alert', 'alert']);
    expect(planRungs('standard', sent, due(120), 'critical').map((r) => r.level)).toEqual(['critical', 'critical', 'critical']);
  });
});

describe('nextRung', () => {
  const rungs = planRungs('standard', NOW, new Date(NOW.getTime() + 120 * 60_000)); // +75 / +105 / +115
  const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
  const st = (rung_sent: number, acknowledged = false, stakes: 'medium' | 'critical' = 'medium') => ({ rungs, rung_sent, acknowledged, stakes });

  const cases: Array<[string, ReturnType<typeof st>, Date, 'normal' | 'quiet_hours' | 'sleep' | 'driving', string]> = [
    ['before the first rung: wait for it', st(0), at(30), 'normal', 'wait:+75'],
    ['first rung due: send it', st(0), at(76), 'normal', 'send:repush'],
    ['first sent, second not yet due: wait', st(1), at(80), 'normal', 'wait:+105'],
    ['two rungs due at once: only the lowest unsent is sent this tick', st(0), at(110), 'normal', 'send:repush'],
    ['after the re-push, the alarm goes on the next tick', st(1), at(110), 'normal', 'send:alarm'],
    ['quiet hours hold a non-critical rung', st(0), at(80), 'quiet_hours', 'hold:repush'],
    ['sleep holds a non-critical rung', st(0), at(80), 'sleep', 'hold:repush'],
    ['critical stakes fire through quiet hours', st(0, false, 'critical'), at(80), 'quiet_hours', 'send:repush'],
    ['driving is not a hold in Phase 1', st(0), at(80), 'driving', 'send:repush'],
    ['acknowledged stops everything, even with rungs due', st(0, true), at(110), 'normal', 'stop'],
    ['all rungs sent: exhausted (expiry sweep takes over)', st(3), at(130), 'normal', 'exhausted'],
  ];
  for (const [name, state, now, mode, expected] of cases) {
    it(name, () => {
      const r = nextRung(state, now, mode);
      const got = r.action === 'send' || r.action === 'hold'
        ? `${r.action}:${r.rung.rung}`
        : r.action === 'wait' ? `wait:+${Math.round((Date.parse(r.next_at) - NOW.getTime()) / 60_000)}` : r.action;
      expect(got).toBe(expected);
    });
  }
});

describe('futureText (tray escalation-honesty line)', () => {
  const due = new Date('2026-09-07T08:00:00Z'); // 11:00 local
  it('do-by lists the unsent rungs with local times', () => {
    const rungs = planRungs('standard', NOW, due); // 10:15 / 10:45 / 10:55 local
    expect(futureText('do-by', rungs, 0, due, TZ)).toBe('re-push 10:15 · alarm 10:45 · reach 10:55');
    expect(futureText('do-by', rungs, 1, due, TZ)).toBe('alarm 10:45 · reach 10:55');
    expect(futureText('do-by', rungs, 3, due, TZ)).toBe('due 11:00 · missed 11:30 if not done');
  });
  it('needs-you states when it expires', () => {
    expect(futureText('needs-you', [], 0, due, TZ)).toBe('due 11:00 · expires 11:30');
  });
});
