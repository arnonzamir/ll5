import { describe, it, expect } from 'vitest';
import { decideMirrorFromListener } from '../scheduler/metrics-monitor.js';

/**
 * channel.mirror decision table (android review 2026-09-05, improvement 1).
 * Pure inputs, no ES/pg — the point of the split is that this table is testable.
 *
 *  enabled | connected | outcome
 *  --------|-----------|--------------------------------------------------
 *  false   | anything  | raise "Notification access not granted"
 *  true    | false     | raise "Notification listener disconnected ..."
 *  null    | false     | raise "Notification listener disconnected ..."
 *  true    | true      | healthy — skip the 24h silence rule this tick
 *  true    | null      | silence-rule (flag unknown, e.g. warming up)
 *  null    | null      | silence-rule (older app build, or no fresh doc)
 */
describe('decideMirrorFromListener', () => {
  it('raises "not granted" when notification access is off', () => {
    const d = decideMirrorFromListener({ enabled: false, connected: false });
    expect(d.kind).toBe('raise');
    if (d.kind !== 'raise') throw new Error('unreachable');
    expect(d.summary).toBe('Notification access not granted');
    expect(d.suggestion).toContain('Grant notification access');
  });

  it('prefers "not granted" over "disconnected" when access is off', () => {
    // enabled=false is the actionable cause; re-arming the listener cannot help.
    const d = decideMirrorFromListener({ enabled: false, connected: null });
    expect(d.kind === 'raise' && d.summary).toBe('Notification access not granted');
  });

  it('raises "disconnected" when granted but the service is not bound', () => {
    const d = decideMirrorFromListener({ enabled: true, connected: false });
    expect(d.kind).toBe('raise');
    if (d.kind !== 'raise') throw new Error('unreachable');
    expect(d.summary).toBe('Notification listener disconnected (Android killed the mirror)');
    expect(d.suggestion).toContain('Open the LL5 app');
  });

  it('raises "disconnected" on connected=false even when enabled is unknown', () => {
    const d = decideMirrorFromListener({ enabled: null, connected: false });
    expect(d.kind === 'raise' && d.summary)
      .toBe('Notification listener disconnected (Android killed the mirror)');
  });

  it('reports healthy when the listener is bound', () => {
    expect(decideMirrorFromListener({ enabled: true, connected: true }).kind).toBe('healthy');
  });

  it('falls back to the silence rule when connected is unknown', () => {
    // The app is warming up after a cold start; do not alert on a guess.
    expect(decideMirrorFromListener({ enabled: true, connected: null }).kind).toBe('silence-rule');
  });

  it('falls back to the silence rule for an older app build (no flags at all)', () => {
    expect(decideMirrorFromListener({ enabled: null, connected: null }).kind).toBe('silence-rule');
  });
});
