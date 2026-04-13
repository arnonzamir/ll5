import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { WifiRepository } from '../interfaces/wifi.repository.js';
import type { WifiConnection, WifiQuery } from '../../types/wifi.js';

const INDEX = 'll5_awareness_wifi_connections';

interface WifiDoc {
  user_id: string;
  ssid?: string;
  bssid?: string;
  rssi_dbm?: number;
  frequency_mhz?: number;
  link_speed_mbps?: number;
  ip_address?: string;
  connected: boolean;
  trigger?: string;
  timestamp: string;
}

function docToWifi(id: string, doc: WifiDoc, userId: string): WifiConnection {
  return {
    id,
    userId,
    ssid: doc.ssid ?? null,
    bssid: doc.bssid ?? null,
    rssiDbm: doc.rssi_dbm,
    frequencyMhz: doc.frequency_mhz,
    linkSpeedMbps: doc.link_speed_mbps,
    ipAddress: doc.ip_address,
    connected: doc.connected,
    trigger: doc.trigger,
    timestamp: doc.timestamp,
  };
}

export class ElasticsearchWifiRepository
  extends BaseElasticsearchRepository
  implements WifiRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getLatest(userId: string): Promise<WifiConnection | null> {
    const { hits } = await this.searchDocs<WifiDoc>(userId, {
      filters: [],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return docToWifi(hits[0]._id!, hits[0]._source, userId);
  }

  async query(userId: string, query: WifiQuery): Promise<WifiConnection[]> {
    const filters: EsQueryContainer[] = [];

    if (query.startTime || query.endTime) {
      const range: Record<string, string> = {};
      if (query.startTime) range.gte = query.startTime;
      if (query.endTime) range.lte = query.endTime;
      filters.push({ range: { timestamp: range } });
    }

    if (query.bssid) {
      filters.push({ term: { bssid: query.bssid } });
    }

    if (query.ssid) {
      filters.push({ term: { 'ssid.keyword': query.ssid } });
    }

    const { hits } = await this.searchDocs<WifiDoc>(userId, {
      filters,
      size: query.limit ?? 100,
      from: query.offset ?? 0,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => docToWifi(h._id!, h._source!, userId));
  }
}
