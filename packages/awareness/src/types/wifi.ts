export interface WifiConnection {
  id: string;
  userId: string;
  ssid: string | null;
  bssid: string | null;
  rssiDbm?: number;
  frequencyMhz?: number;
  linkSpeedMbps?: number;
  ipAddress?: string;
  connected: boolean;
  trigger?: string;
  timestamp: string;
}

export interface WifiQuery {
  startTime?: string;
  endTime?: string;
  bssid?: string;
  ssid?: string;
  limit?: number;
  offset?: number;
}
