/** Write-time plausibility filtering — pure, ported from the gateway. */
import {
  LOW_ACCURACY_METERS,
  MAX_ACCURACY_METERS,
  DRIFT_WINDOW_MIN,
  IMPLAUSIBLE_SPEED_KMH,
  ABSOLUTE_MAX_SPEED_KMH,
  DEVICE_STATIONARY_SPEED_KMH,
  SPEED_AGREEMENT_RATIO,
  KNOWN_PLACE_DRIFT_KM,
  KNOWN_PLACE_DRIFT_MIN,
} from './constants.js';
import { haversineKm } from './geo.js';

export interface AccuracyVerdict {
  /** Drop the point entirely (garbage accuracy). */
  drop: boolean;
  /** Keep, but flag as low-accuracy so downstream down-weights it. */
  lowAccuracy: boolean;
}

/** Gate a fix on reported accuracy: drop garbage (>MAX), flag low (>LOW). */
export function gateAccuracy(accuracyM?: number | null): AccuracyVerdict {
  if (accuracyM != null && accuracyM > MAX_ACCURACY_METERS) {
    return { drop: true, lowAccuracy: false };
  }
  if (accuracyM != null && accuracyM > LOW_ACCURACY_METERS) {
    return { drop: false, lowAccuracy: true };
  }
  return { drop: false, lowAccuracy: false };
}

export interface DriftPoint {
  lat: number;
  lon: number;
  timestampMs: number;
}

export interface DriftPrev extends DriftPoint {
  /** Whether the predecessor was AT a known place (enables the jitter guard). */
  atKnownPlace: boolean;
}

export interface DriftVerdict {
  drop: boolean;
  reason?: string;
}

/**
 * Decide whether `point` is a teleport/drift glitch relative to `prev`.
 * Mirrors the gateway's drift filter: absolute-ceiling drop, implausible-speed
 * drop unless device speed corroborates real travel, and a stationary-jitter
 * guard near a known place. Returns {drop:false} when there's nothing to compare.
 */
export function detectDriftGlitch(
  prev: DriftPrev | null | undefined,
  point: DriftPoint,
  deviceSpeedKmh?: number | null,
): DriftVerdict {
  if (!prev) return { drop: false };
  const timeDiffMs = point.timestampMs - prev.timestampMs;
  const timeDiffMin = timeDiffMs / 60_000;
  // Non-positive delta (out-of-order / clock skew): skip speed math, don't drop.
  if (timeDiffMin <= 0 || timeDiffMin >= DRIFT_WINDOW_MIN) return { drop: false };

  const distKm = haversineKm(prev, point);
  const computedSpeedKmh = distKm / (timeDiffMs / 3_600_000);

  if (computedSpeedKmh > ABSOLUTE_MAX_SPEED_KMH) {
    return { drop: true, reason: 'speed over absolute ceiling' };
  }

  if (computedSpeedKmh > IMPLAUSIBLE_SPEED_KMH) {
    const deviceConfirmsTravel =
      deviceSpeedKmh != null &&
      deviceSpeedKmh > DEVICE_STATIONARY_SPEED_KMH &&
      deviceSpeedKmh >= computedSpeedKmh * SPEED_AGREEMENT_RATIO;
    if (!deviceConfirmsTravel) {
      return { drop: true, reason: 'implausible jump, device speed low/absent' };
    }
  }

  if (
    prev.atKnownPlace &&
    distKm > KNOWN_PLACE_DRIFT_KM &&
    timeDiffMin < KNOWN_PLACE_DRIFT_MIN &&
    !(deviceSpeedKmh != null && deviceSpeedKmh > DEVICE_STATIONARY_SPEED_KMH)
  ) {
    return { drop: true, reason: 'drift from known place' };
  }

  return { drop: false };
}
