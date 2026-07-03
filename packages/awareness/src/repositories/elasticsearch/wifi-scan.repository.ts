import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { WifiScanRepository } from '../interfaces/wifi-scan.repository.js';
import type { WifiScan } from '../../types/wifi.js';

const INDEX = 'll5_awareness_wifi_scans';

interface WifiScanDoc {
  user_id: string;
  timestamp: string;
  networks?: Array<{
    ssid?: string | null;
    bssid?: string;
    rssi?: number;
    frequency_mhz?: number;
  }>;
  connected_bssid?: string | null;
}

function docToScan(id: string, doc: WifiScanDoc, userId: string): WifiScan {
  return {
    id,
    userId,
    timestamp: doc.timestamp,
    networks: (doc.networks ?? [])
      .filter((n) => !!n.bssid && typeof n.rssi === 'number')
      .map((n) => ({
        ssid: n.ssid ?? null,
        bssid: n.bssid!,
        rssi: n.rssi!,
        frequencyMhz: n.frequency_mhz,
      })),
    connectedBssid: doc.connected_bssid ?? null,
  };
}

export class ElasticsearchWifiScanRepository
  extends BaseElasticsearchRepository
  implements WifiScanRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getLatest(userId: string): Promise<WifiScan | null> {
    const { hits } = await this.searchDocs<WifiScanDoc>(userId, {
      filters: [],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return docToScan(hits[0]._id!, hits[0]._source, userId);
  }
}
