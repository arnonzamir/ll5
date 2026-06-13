import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { BluetoothRepository } from '../interfaces/bluetooth.repository.js';
import type {
  BluetoothEvent,
  BluetoothQuery,
  BluetoothConnection,
} from '../../types/bluetooth.js';

const INDEX = 'll5_awareness_bluetooth';

interface BluetoothDoc {
  user_id: string;
  connected: boolean;
  device_name?: string;
  device_address?: string;
  device_class?: string;
  timestamp: string;
}

function docToBluetoothEvent(id: string, doc: BluetoothDoc, userId: string): BluetoothEvent {
  return {
    id,
    userId,
    connected: doc.connected,
    deviceName: doc.device_name,
    deviceAddress: doc.device_address,
    deviceClass: doc.device_class,
    timestamp: doc.timestamp,
  };
}

export class ElasticsearchBluetoothRepository
  extends BaseElasticsearchRepository
  implements BluetoothRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async query(userId: string, query: BluetoothQuery): Promise<BluetoothEvent[]> {
    const filters: EsQueryContainer[] = [];
    if (query.startTime || query.endTime) {
      const range: Record<string, string> = {};
      if (query.startTime) range.gte = query.startTime;
      if (query.endTime) range.lte = query.endTime;
      filters.push({ range: { timestamp: range } });
    }

    const { hits } = await this.searchDocs<BluetoothDoc>(userId, {
      filters,
      size: query.limit ?? 100,
      from: query.offset ?? 0,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => docToBluetoothEvent(h._id!, h._source!, userId));
  }

  async getConnected(userId: string, lookbackHours = 24): Promise<BluetoothConnection[]> {
    const since = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
    const { hits } = await this.searchDocs<BluetoothDoc>(userId, {
      filters: [{ range: { timestamp: { gte: since } } }],
      size: 500,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    // Reduce to the latest event per device address; keep those still connected.
    const seen = new Set<string>();
    const connected: BluetoothConnection[] = [];
    for (const h of hits) {
      const doc = h._source;
      if (!doc) continue;
      const key = doc.device_address ?? doc.device_name ?? h._id!;
      if (seen.has(key)) continue; // sorted desc → first seen is the latest
      seen.add(key);
      if (doc.connected) {
        connected.push({
          deviceName: doc.device_name,
          deviceAddress: doc.device_address,
          deviceClass: doc.device_class,
          since: doc.timestamp,
        });
      }
    }
    return connected;
  }
}
