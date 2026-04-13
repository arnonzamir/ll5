import type { WifiConnection, WifiQuery } from '../../types/wifi.js';

export interface WifiRepository {
  getLatest(userId: string): Promise<WifiConnection | null>;
  query(userId: string, query: WifiQuery): Promise<WifiConnection[]>;
}
