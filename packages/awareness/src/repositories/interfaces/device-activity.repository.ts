import type { DeviceActivity, DeviceActivityQuery } from '../../types/device-activity.js';

export interface DeviceActivityRepository {
  getLatest(userId: string): Promise<DeviceActivity | null>;
  query(userId: string, query: DeviceActivityQuery): Promise<DeviceActivity[]>;
}
