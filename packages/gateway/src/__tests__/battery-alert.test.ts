import { describe, it, expect } from 'vitest';
import {
  decideBatteryAlert,
  initialBatteryAlertState,
  type BatteryAlertState,
} from '../processors/battery-alert.js';

describe('decideBatteryAlert — escalating low-battery decision', () => {
  it('alerts at 20% (notify) when discharging', () => {
    const r = decideBatteryAlert(initialBatteryAlertState, 20, false);
    expect(r.alert).toEqual({
      threshold: 20,
      level: 'notify',
      text: '[Phone] Battery at 20% and unplugged — worth finding a charger.',
    });
    expect(r.newState.lastAlertedThreshold).toBe(20);
  });

  it('does not re-alert at 19/18 once 20% fired (same threshold band)', () => {
    let state: BatteryAlertState = initialBatteryAlertState;
    state = decideBatteryAlert(state, 20, false).newState;

    const r19 = decideBatteryAlert(state, 19, false);
    expect(r19.alert).toBeUndefined();
    const r18 = decideBatteryAlert(r19.newState, 18, false);
    expect(r18.alert).toBeUndefined();
  });

  it('escalates to 10% (notify) then 5% (alert)', () => {
    let state: BatteryAlertState = initialBatteryAlertState;
    state = decideBatteryAlert(state, 20, false).newState;

    const r10 = decideBatteryAlert(state, 10, false);
    expect(r10.alert).toEqual({
      threshold: 10,
      level: 'notify',
      text: '[Phone] Battery low: 10% and still unplugged.',
    });
    state = r10.newState;

    const r5 = decideBatteryAlert(state, 5, false);
    expect(r5.alert).toEqual({
      threshold: 5,
      level: 'alert',
      text: '[Phone] Critical: phone at 5% — plug in now.',
    });
  });

  it('does not alert when charging, even below thresholds', () => {
    const r = decideBatteryAlert(initialBatteryAlertState, 5, true);
    expect(r.alert).toBeUndefined();
    expect(r.newState.lastAlertedThreshold).toBeNull();
  });

  it('resets after charging, then re-alerts on next discharge below 20', () => {
    let state: BatteryAlertState = initialBatteryAlertState;
    // Discharge episode 1: fire 20.
    state = decideBatteryAlert(state, 18, false).newState;
    expect(state.lastAlertedThreshold).toBe(20);

    // Plug in → episode resets.
    const charged = decideBatteryAlert(state, 30, true);
    expect(charged.newState.lastAlertedThreshold).toBeNull();
    state = charged.newState;

    // Discharge episode 2: 20 should fire again.
    const r = decideBatteryAlert(state, 19, false);
    expect(r.alert?.threshold).toBe(20);
  });

  it('resets the episode when battery rises back above 20%', () => {
    let state: BatteryAlertState = initialBatteryAlertState;
    state = decideBatteryAlert(state, 10, false).newState;
    expect(state.lastAlertedThreshold).toBe(10);

    // Battery climbs above 20% (still unplugged but recovered) → reset.
    const recovered = decideBatteryAlert(state, 25, false);
    expect(recovered.alert).toBeUndefined();
    expect(recovered.newState.lastAlertedThreshold).toBeNull();
  });

  it('does not alert when battery is high and discharging', () => {
    const r = decideBatteryAlert(initialBatteryAlertState, 80, false);
    expect(r.alert).toBeUndefined();
    expect(r.newState.lastAlertedThreshold).toBeNull();
  });

  it('crossing straight to 5% from a fresh episode fires the 5% alert', () => {
    const r = decideBatteryAlert(initialBatteryAlertState, 5, false);
    expect(r.alert?.threshold).toBe(5);
    expect(r.alert?.level).toBe('alert');
  });
});
