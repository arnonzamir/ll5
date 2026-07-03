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

/** One network seen in a wifi SCAN (DECISION-021) — visible, not necessarily joined. */
export interface WifiScanNetwork {
  ssid: string | null;
  bssid: string;
  rssi: number;
  frequencyMhz?: number;
}

/** A visible-network scan doc from ll5_awareness_wifi_scans. */
export interface WifiScan {
  id: string;
  userId: string;
  timestamp: string;
  networks: WifiScanNetwork[];
  connectedBssid: string | null;
}

export interface WifiQuery {
  startTime?: string;
  endTime?: string;
  bssid?: string;
  ssid?: string;
  limit?: number;
  offset?: number;
}
