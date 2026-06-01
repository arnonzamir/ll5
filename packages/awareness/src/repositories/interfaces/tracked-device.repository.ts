import type { TrackedDevice } from '../../types/tracked-device.js';

export interface TrackedDeviceRepository {
  /** All tracked devices for a user, most-recently-seen first. */
  listAll(userId: string, limit?: number): Promise<TrackedDevice[]>;

  /** Best fuzzy name match for a single device, or null. */
  getByName(userId: string, name: string): Promise<TrackedDevice | null>;
}
