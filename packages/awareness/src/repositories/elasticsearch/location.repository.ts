import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { LocationRepository } from '../interfaces/location.repository.js';
import type { Location, LocationQuery, GeoPoint } from '../../types/location.js';

const INDEX = 'll5_awareness_locations';

interface LocationDoc {
  user_id: string;
  location: { lat: number; lon: number };
  accuracy?: number;
  speed?: number;
  address?: string;
  matched_place_id?: string;
  matched_place?: string;
  device_timezone?: string;
  timestamp: string;
}

export class ElasticsearchLocationRepository
  extends BaseElasticsearchRepository
  implements LocationRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getLatest(userId: string): Promise<Location | null> {
    const { hits } = await this.searchDocs<LocationDoc>(userId, {
      filters: [],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    if (hits.length === 0 || !hits[0]?._source) return null;
    return this.mapToLocation(hits[0]._id!, hits[0]._source, userId);
  }

  async query(userId: string, query: LocationQuery): Promise<Location[]> {
    const filters: EsQueryContainer[] = [];

    if (query.startTime || query.endTime) {
      const range: Record<string, string> = {};
      if (query.startTime) range.gte = query.startTime;
      if (query.endTime) range.lte = query.endTime;
      filters.push({ range: { timestamp: range } });
    }

    if (query.placeId) {
      filters.push({ term: { matched_place_id: query.placeId } });
    }

    const { hits } = await this.searchDocs<LocationDoc>(userId, {
      filters,
      size: query.limit ?? 100,
      from: query.offset ?? 0,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => this.mapToLocation(h._id!, h._source!, userId));
  }

  async create(
    userId: string,
    data: {
      location: GeoPoint;
      accuracy?: number;
      speed?: number;
      address?: string;
      matchedPlaceId?: string;
      matchedPlace?: string;
      deviceTimezone?: string;
      timestamp: string;
    },
  ): Promise<Location> {
    const id = this.generateId();
    const doc: LocationDoc = {
      user_id: userId,
      location: { lat: data.location.lat, lon: data.location.lon },
      accuracy: data.accuracy,
      speed: data.speed,
      address: data.address,
      matched_place_id: data.matchedPlaceId,
      matched_place: data.matchedPlace,
      device_timezone: data.deviceTimezone,
      timestamp: data.timestamp,
    };

    await this.indexDoc(id, doc as unknown as Record<string, unknown>);

    return {
      id,
      userId,
      location: data.location,
      accuracy: data.accuracy,
      speed: data.speed,
      address: data.address,
      matchedPlaceId: data.matchedPlaceId,
      matchedPlace: data.matchedPlace,
      deviceTimezone: data.deviceTimezone,
      timestamp: data.timestamp,
    };
  }

  private mapToLocation(id: string, doc: LocationDoc, userId: string): Location {
    return {
      id,
      userId,
      location: { lat: doc.location.lat, lon: doc.location.lon },
      accuracy: doc.accuracy,
      speed: doc.speed,
      address: doc.address,
      matchedPlaceId: doc.matched_place_id,
      matchedPlace: doc.matched_place,
      deviceTimezone: doc.device_timezone,
      timestamp: doc.timestamp,
    };
  }
}
