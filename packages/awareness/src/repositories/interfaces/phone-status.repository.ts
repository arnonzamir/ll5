import type { PhoneStatus, PhoneStatusQuery } from '../../types/phone-status.js';

export interface PhoneStatusRepository {
  getLatest(userId: string): Promise<PhoneStatus | null>;
  query(userId: string, query: PhoneStatusQuery): Promise<PhoneStatus[]>;
}
