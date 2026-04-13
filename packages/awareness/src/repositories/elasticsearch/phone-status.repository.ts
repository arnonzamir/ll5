import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { PhoneStatusRepository } from '../interfaces/phone-status.repository.js';
import type { PhoneStatus, PhoneStatusQuery } from '../../types/phone-status.js';

const INDEX = 'll5_awareness_phone_statuses';

interface PhoneStatusDoc {
  user_id: string;
  battery_pct: number;
  is_charging: boolean;
  plug_type?: string;
  battery_temp_c?: number;
  battery_health?: string;
  low_power_mode?: boolean;
  storage_used_bytes?: number;
  storage_total_bytes?: number;
  ram_used_bytes?: number;
  ram_total_bytes?: number;
  trigger?: string;
  timestamp: string;
}

function docToPhoneStatus(id: string, doc: PhoneStatusDoc, userId: string): PhoneStatus {
  return {
    id,
    userId,
    batteryPct: doc.battery_pct,
    isCharging: doc.is_charging,
    plugType: doc.plug_type,
    batteryTempC: doc.battery_temp_c,
    batteryHealth: doc.battery_health,
    lowPowerMode: doc.low_power_mode,
    storageUsedBytes: doc.storage_used_bytes,
    storageTotalBytes: doc.storage_total_bytes,
    ramUsedBytes: doc.ram_used_bytes,
    ramTotalBytes: doc.ram_total_bytes,
    trigger: doc.trigger,
    timestamp: doc.timestamp,
  };
}

export class ElasticsearchPhoneStatusRepository
  extends BaseElasticsearchRepository
  implements PhoneStatusRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getLatest(userId: string): Promise<PhoneStatus | null> {
    const { hits } = await this.searchDocs<PhoneStatusDoc>(userId, {
      filters: [],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return docToPhoneStatus(hits[0]._id!, hits[0]._source, userId);
  }

  async query(userId: string, query: PhoneStatusQuery): Promise<PhoneStatus[]> {
    const filters: EsQueryContainer[] = [];

    if (query.startTime || query.endTime) {
      const range: Record<string, string> = {};
      if (query.startTime) range.gte = query.startTime;
      if (query.endTime) range.lte = query.endTime;
      filters.push({ range: { timestamp: range } });
    }

    const { hits } = await this.searchDocs<PhoneStatusDoc>(userId, {
      filters,
      size: query.limit ?? 100,
      from: query.offset ?? 0,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => docToPhoneStatus(h._id!, h._source!, userId));
  }
}
