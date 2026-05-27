import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';

export type BatteryAlertLevel = 'notify' | 'alert';

/**
 * Escalating low-battery thresholds. Ordered high → low so we fire the
 * highest threshold the battery has crossed DOWN past that hasn't yet fired
 * this discharge episode. Each fires at most once per episode.
 */
interface ThresholdSpec {
  pct: number;
  level: BatteryAlertLevel;
  text: string;
}

const THRESHOLDS: ThresholdSpec[] = [
  { pct: 5, level: 'alert', text: '[Phone] Critical: phone at 5% — plug in now.' },
  { pct: 10, level: 'notify', text: '[Phone] Battery low: 10% and still unplugged.' },
  { pct: 20, level: 'notify', text: '[Phone] Battery at 20% and unplugged — worth finding a charger.' },
];

/** Highest threshold pct — episode resets once battery rises back above this. */
const RESET_ABOVE_PCT = 20;

export interface BatteryAlertState {
  /**
   * The lowest threshold pct already alerted this discharge episode, or null
   * if none. Higher (less urgent) thresholds at or above this are suppressed;
   * we only escalate to lower thresholds.
   */
  lastAlertedThreshold: number | null;
}

export interface BatteryAlertDecision {
  alert?: { threshold: number; level: BatteryAlertLevel; text: string };
  newState: BatteryAlertState;
}

export const initialBatteryAlertState: BatteryAlertState = { lastAlertedThreshold: null };

/**
 * Pure decision function for the escalating low-battery alert.
 *
 * - Only alerts while DISCHARGING (isCharging === false).
 * - Fires the most urgent (lowest) not-yet-alerted threshold the battery has
 *   crossed down past this episode. Each threshold fires at most once.
 * - Resets the episode (so future discharges re-alert) when charging OR when
 *   battery rises back above the top threshold.
 */
export function decideBatteryAlert(
  prevState: BatteryAlertState,
  batteryPct: number,
  isCharging: boolean,
): BatteryAlertDecision {
  // Charging, or recovered above the top threshold → reset the episode.
  if (isCharging || batteryPct > RESET_ABOVE_PCT) {
    return { newState: { lastAlertedThreshold: null } };
  }

  // Discharging at/below the top threshold. Find the most urgent threshold the
  // battery currently satisfies that we haven't alerted yet this episode.
  for (const t of THRESHOLDS) {
    if (batteryPct > t.pct) continue; // not crossed down past this one yet
    const alreadyAlerted = prevState.lastAlertedThreshold !== null && prevState.lastAlertedThreshold <= t.pct;
    if (alreadyAlerted) continue;
    return {
      alert: { threshold: t.pct, level: t.level, text: t.text },
      newState: { lastAlertedThreshold: t.pct },
    };
  }

  // Below the top threshold but nothing new to alert (same threshold band).
  return { newState: prevState };
}

// In-memory per-user episode state. Resets on gateway restart (acceptable).
const stateByUser = new Map<string, BatteryAlertState>();

/**
 * Thin wrapper: runs the decision against the user's in-memory state, persists
 * the new state, and surfaces a system message (with FCM push) when an alert
 * fires. Fire-and-forget; logs on failure.
 */
export async function maybeAlertLowBattery(
  pool: Pool,
  userId: string,
  batteryPct: number,
  isCharging: boolean,
): Promise<void> {
  const prev = stateByUser.get(userId) ?? initialBatteryAlertState;
  const { alert, newState } = decideBatteryAlert(prev, batteryPct, isCharging);
  stateByUser.set(userId, newState);

  if (!alert) return;

  try {
    await insertSystemMessage(pool, userId, alert.text, {
      title: 'Battery',
      type: 'battery',
      priority: alert.level === 'alert' ? 'high' : 'normal',
    });
    logger.info('[battery-alert][maybeAlertLowBattery] Alert sent', {
      userId,
      threshold: alert.threshold,
      level: alert.level,
      batteryPct,
    });
  } catch (err) {
    logger.warn('[battery-alert][maybeAlertLowBattery] Failed to surface battery alert', {
      error: String(err),
      userId,
    });
  }
}
