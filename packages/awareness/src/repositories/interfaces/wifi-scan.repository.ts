import type { WifiScan } from '../../types/wifi.js';

export interface WifiScanRepository {
  /** Latest visible-network scan for the user, or null when none exist. */
  getLatest(userId: string): Promise<WifiScan | null>;
}
