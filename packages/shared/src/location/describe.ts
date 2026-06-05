import { STATIONARY_SPEED_MPS, DRIVING_SPEED_MPS } from './constants.js';
import type { GpsSignal, Motion } from './types.js';

const CARDINALS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

/** Bearing in degrees (0=N, clockwise) → an 8-point cardinal word. */
export function cardinal(bearingDeg: number): string {
  const idx = Math.round(((bearingDeg % 360) + 360) % 360 / 45) % 8;
  return CARDINALS[idx];
}

/** Classify motion from device speed (m/s). 'unknown' when speed is absent. */
export function motionState(speedMps?: number | null): Motion {
  if (speedMps == null) return 'unknown';
  if (speedMps <= STATIONARY_SPEED_MPS) return 'stationary';
  if (speedMps >= DRIVING_SPEED_MPS) return 'driving';
  return 'walking';
}

/**
 * Build a USEFUL human description from the (non-place) GPS context — the thing to
 * actually surface instead of a bare "you're in <city>":
 *   - driving:    "on Route 6, heading south — near Kfar Saba"
 *   - stationary: "near Masada St, Haifa"  (street/neighbourhood + city)
 *   - fallback:   the city, or coordinates.
 * `placeName` short-circuits everything (a known place is the best description).
 */
export function describeLocation(gps: GpsSignal | null | undefined, placeName: string | null): {
  description: string;
  motion: Motion;
} {
  const motion = motionState(gps?.speedMps);
  if (placeName) return { description: placeName, motion };
  if (!gps) return { description: 'location unknown', motion };

  const city = gps.city || null;
  const road = gps.road || null;
  const hood = gps.neighborhood || null;
  const dir = gps.bearingDeg != null ? cardinal(gps.bearingDeg) : null;

  if (motion === 'driving') {
    const lead: string[] = [];
    if (road) lead.push(`on ${road}`);
    if (dir) lead.push(`heading ${dir}`);
    let s = lead.length ? `driving ${lead.join(', ')}` : 'driving';
    if (city) s += ` — near ${city}`;
    return { description: s, motion };
  }

  // stationary / walking / unknown motion at an unknown spot
  const spot = road || hood;
  if (spot && city) return { description: `near ${spot}, ${city}`, motion };
  if (spot) return { description: `near ${spot}`, motion };
  if (city) return { description: `near ${city}`, motion };
  return { description: `at (${gps.lat.toFixed(4)}, ${gps.lon.toFixed(4)})`, motion };
}
