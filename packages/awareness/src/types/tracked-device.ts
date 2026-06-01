import { computeFreshness, type LocationFreshness } from './location.js';

export type TrackedDeviceType = 'phone' | 'tablet' | 'watch' | 'tracker' | 'unknown';

/**
 * Current location of a device/tracker on the Google Find Hub network.
 * One per physical device (current state), not a stream.
 */
export interface TrackedDevice {
  id: string;
  userId: string;
  deviceId: string;
  name: string;
  deviceType: TrackedDeviceType;
  location: { lat: number; lon: number };
  accuracy?: number;
  batteryPct?: number;
  semanticName?: string;
  address?: string;
  matchedPlaceId?: string;
  matchedPlace?: string;
  /** When the Find Hub network last located the device. */
  lastSeen: string;
  /** When the gateway last ingested a fix. */
  updatedAt?: string;
}

export { computeFreshness };
export type { LocationFreshness };
