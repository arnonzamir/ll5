import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { TrackedDeviceRepository } from '../interfaces/tracked-device.repository.js';
import type { TrackedDevice, TrackedDeviceType } from '../../types/tracked-device.js';

const INDEX = 'll5_awareness_tracked_devices';

interface TrackedDeviceDoc {
  user_id: string;
  device_id: string;
  name: string;
  device_type?: string;
  location: { lat: number; lon: number };
  accuracy?: number;
  battery_pct?: number;
  semantic_name?: string;
  address?: string;
  matched_place_id?: string;
  matched_place?: string;
  last_seen: string;
  updated_at?: string;
}

const KNOWN_TYPES: TrackedDeviceType[] = ['phone', 'tablet', 'watch', 'tracker', 'unknown'];

export class ElasticsearchTrackedDeviceRepository
  extends BaseElasticsearchRepository
  implements TrackedDeviceRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async listAll(userId: string, limit = 50): Promise<TrackedDevice[]> {
    const { hits } = await this.searchDocs<TrackedDeviceDoc>(userId, {
      filters: [],
      size: limit,
      sort: [{ last_seen: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => this.mapToDevice(h._id!, h._source!, userId));
  }

  async getByName(userId: string, name: string): Promise<TrackedDevice | null> {
    const { hits } = await this.searchDocs<TrackedDeviceDoc>(userId, {
      musts: [
        {
          match: {
            name: { query: name, fuzziness: 'AUTO' },
          },
        },
      ],
      size: 1,
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return this.mapToDevice(hits[0]._id!, hits[0]._source, userId);
  }

  private mapToDevice(id: string, doc: TrackedDeviceDoc, userId: string): TrackedDevice {
    const deviceType = (KNOWN_TYPES as string[]).includes(doc.device_type ?? '')
      ? (doc.device_type as TrackedDeviceType)
      : 'unknown';

    return {
      id,
      userId,
      deviceId: doc.device_id,
      name: doc.name,
      deviceType,
      location: { lat: doc.location.lat, lon: doc.location.lon },
      accuracy: doc.accuracy,
      batteryPct: doc.battery_pct,
      semanticName: doc.semantic_name,
      address: doc.address,
      matchedPlaceId: doc.matched_place_id,
      matchedPlace: doc.matched_place,
      lastSeen: doc.last_seen,
      updatedAt: doc.updated_at,
    };
  }
}
