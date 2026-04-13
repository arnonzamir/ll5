export interface PhoneStatus {
  id: string;
  userId: string;
  batteryPct: number;
  isCharging: boolean;
  plugType?: string;
  batteryTempC?: number;
  batteryHealth?: string;
  lowPowerMode?: boolean;
  storageUsedBytes?: number;
  storageTotalBytes?: number;
  ramUsedBytes?: number;
  ramTotalBytes?: number;
  trigger?: string;
  timestamp: string;
}

export interface PhoneStatusQuery {
  startTime?: string;
  endTime?: string;
  limit?: number;
  offset?: number;
}
