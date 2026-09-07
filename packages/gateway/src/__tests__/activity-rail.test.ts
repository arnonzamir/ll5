import { describe, it, expect } from 'vitest';
import { composeActivity, decodeCursor, encodeCursor } from '../utils/activity-rail.js';
import type { ChatRowDoc, JournalDoc, MomentDoc } from '../utils/activity-rail.js';

// DECISION-034 Phase 2 — the activity rail composed from fixture rows.

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001'; // trigger: calendar review system row
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002'; // trigger: whatsapp inbound
const M1 = 'bbbbbbbb-0000-4000-8000-000000000001'; // classed message produced in turn 1

const chatRows: ChatRowDoc[] = [
  { id: T1, role: 'system', channel: 'system', content: '[Calendar Review] Dentist 10:00 tomorrow\n[event_id: evt_1]', created_at: '2026-09-07T08:00:00Z', metadata: { scheduler: 'calendar_review', event_id: 'evt_1' } },
  { id: 'r1', role: 'assistant', channel: 'web', content: 'Checking the calendar for conflicts...', created_at: '2026-09-07T08:00:20Z', metadata: { kind: 'thinking', rail: true, trigger_id: T1 } },
  { id: 'r2', role: 'assistant', channel: 'web', content: 'Moved the dentist reminder to 09:30.\nsecond line', created_at: '2026-09-07T08:00:40Z', metadata: { kind: 'thinking', rail: true, trigger_id: T1 } },
  { id: M1, role: 'assistant', channel: 'web', content: 'Dentist 10:00 — leave by 09:30.', created_at: '2026-09-07T08:01:00Z', metadata: { class: 'needs-you', subject: 'Dentist 10:00' } },
  { id: T2, role: 'user', channel: 'whatsapp', content: 'hey, are we still on for tonight?', created_at: '2026-09-07T09:00:00Z', metadata: { source: { platform: 'whatsapp', contact_name: 'Dana' } } },
  { id: 'r3', role: 'assistant', channel: 'web', content: 'Dana asks about tonight; nothing on the calendar, no ping.', created_at: '2026-09-07T09:00:30Z', metadata: { kind: 'thinking', rail: true, trigger_id: T2 } },
  // a user-turn narrate row: not rail, never an entry
  { id: 'n1', role: 'assistant', channel: 'web', content: 'thinking aloud', created_at: '2026-09-07T09:30:00Z', metadata: { kind: 'thinking' } },
];

const journal: JournalDoc[] = [
  { id: 'j1', created_at: '2026-09-07T08:00:50Z', session_id: 'sess-A', topic: 'dentist', content: 'Moved reminder earlier; user leaves 30 min before appointments.' },
  { id: 'j2', created_at: '2026-09-07T09:00:45Z', session_id: 'sess-A', topic: 'Dana', content: 'no plans tonight' },
];

describe('composeActivity — keyed by trigger_id', () => {
  const moments: MomentDoc[] = [
    { id: 'e1', timestamp: '2026-09-07T08:00:00Z', session_id: 'sess-A', trigger_id: T1, decision: 'ping_now', reason: 'conflict tomorrow morning', category: 'calendar', produced_message_id: M1 },
    { id: 'e2', timestamp: '2026-09-07T09:00:00Z', session_id: 'sess-A', trigger_id: T2, decision: 'suppress', reason: 'nothing to add', category: 'social', trigger_class: 'message', source: 'whatsapp' },
  ];

  it('one entry per trigger, newest first, with thought / decision / journal / outcome', () => {
    const entries = composeActivity({ moments, chatRows, journal, deliveries: [{ message_id: M1, tray_item_id: 'tray-1', class: 'needs-you', created_at: '2026-09-07T08:01:00Z' }], costs: [{ id: 'c1', session_id: 'sess-A', timestamp: '2026-09-07T08:00:55Z', cost_usd: 0.012 }] });
    expect(entries.map((e) => e.id)).toEqual([T2, T1]);

    const first = entries[1];
    expect(first.at).toBe('2026-09-07T08:00:00.000Z');
    expect(first.trigger).toEqual({ id: T1, kind: 'calendar_review', summary: '[Calendar Review] Dentist 10:00 tomorrow' });
    expect(first.thought).toBe('Moved the dentist reminder to 09:30.');   // last rail row, first line
    expect(first.decision).toBe('ping_now');
    expect(first.reason).toBe('conflict tomorrow morning');
    expect(first.category).toBe('calendar');
    expect(first.outcome).toEqual({ message_id: M1, tray_item_id: 'tray-1', class: 'needs-you' });
    expect(first.journal).toEqual({ id: 'j1', topic: 'dentist', content: 'Moved reminder earlier; user leaves 30 min before appointments.' });
    expect(first.cost_usd).toBe(0.012);

    const second = entries[0];
    expect(second.trigger).toEqual({ id: T2, kind: 'whatsapp', summary: 'hey, are we still on for tonight?' });
    expect(second.decision).toBe('suppress');
    expect(second.outcome).toEqual({});
    expect(second.journal?.id).toBe('j2');
    expect(second.cost_usd).toBeUndefined();
  });

  it('rail rows alone (no moment yet) still make an entry; a plain narrate row never does', () => {
    const entries = composeActivity({ moments: [], chatRows, journal: [], deliveries: [] });
    expect(entries.map((e) => e.id)).toEqual([T2, T1]);
    expect(entries[1].decision).toBeNull();
    expect(entries[1].thought).toBe('Moved the dentist reminder to 09:30.');
    expect(entries[1].outcome.message_id).toBe(M1); // classed row inside the turn window
  });
});

describe('composeActivity — moments without trigger_id fall back to session + window', () => {
  it('a moment joins the nearest preceding trigger group inside the window; a stray one stands alone', () => {
    const moments: MomentDoc[] = [
      { id: 'e1', timestamp: '2026-09-07T08:00:05Z', session_id: 'sess-A', decision: 'ping_now', reason: 'conflict', category: 'calendar' },
      { id: 'e2', timestamp: '2026-09-07T09:00:02Z', session_id: 'sess-A', decision: 'suppress', reason: 'nothing', category: 'social' },
      { id: 'e3', timestamp: '2026-09-07T12:00:00Z', session_id: 'sess-A', decision: 'ping_later', deferral_ref: 'wake_77', reason: 'evening', trigger_class: 'heartbeat', source: 'scheduler' },
    ];
    const entries = composeActivity({ moments, chatRows, journal, deliveries: [] });
    expect(entries.map((e) => e.id)).toEqual(['moment:e3', T2, T1]);
    expect(entries[2].decision).toBe('ping_now');
    expect(entries[2].outcome.message_id).toBe(M1);
    expect(entries[1].decision).toBe('suppress');
    const stray = entries[0];
    expect(stray.trigger).toEqual({ id: null, kind: 'heartbeat', summary: 'heartbeat · scheduler' });
    expect(stray.thought).toBe('evening');          // no rail row → the moment's reason
    expect(stray.outcome).toEqual({ deferral_ref: 'wake_77' });
  });

  it('the turn window ends at the next moment of the same session — a later journal entry is not attached', () => {
    const moments: MomentDoc[] = [
      { id: 'e1', timestamp: '2026-09-07T08:00:03Z', session_id: 'sess-A', trigger_id: T1, decision: 'ping_now' },
      // no trigger_id; T1 already has its moment → stands alone at 08:00:45
      { id: 'e2', timestamp: '2026-09-07T08:00:45Z', session_id: 'sess-A', decision: 'suppress' },
    ];
    const j: JournalDoc[] = [{ id: 'jx', created_at: '2026-09-07T08:00:50Z', session_id: 'sess-A', topic: 'x', content: 'x' }];
    const entries = composeActivity({ moments, chatRows: chatRows.slice(0, 4), journal: j, deliveries: [] });
    expect(entries.map((e) => e.id)).toEqual(['moment:e2', T1]);
    expect(entries.find((e) => e.id === T1)!.journal).toBeNull();
    expect(entries.find((e) => e.id === 'moment:e2')!.journal?.id).toBe('jx');
  });
});

describe('cursor', () => {
  it('round-trips an ISO instant and rejects junk', () => {
    const c = encodeCursor('2026-09-07T08:00:00.000Z');
    expect(decodeCursor(c)).toBe('2026-09-07T08:00:00.000Z');
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('!!!')).toBeNull();
  });
});
