import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { NetworkRepository } from '../interfaces/network.repository.js';
import type { KnownNetwork, PlaceObservation, ResolvedPlaceForBssid } from '../../types/network.js';

const INDEX = 'll5_knowledge_networks';

// Min observations before an auto-learned binding becomes "confident".
// Below this, resolvePlaceByBssid returns null even if observations exist.
const MIN_AUTO_OBSERVATIONS = 3;

interface NetworkDoc {
  user_id: string;
  bssid: string;
  ssid?: string;
  place_observations?: Array<{
    place_id: string;
    place_name: string;
    count: number;
    last_seen: string;
  }>;
  manual_place_id?: string;
  manual_place_name?: string;
  label?: string;
  total_observations: number;
  first_seen: string;
  last_seen: string;
  created_at: string;
  updated_at: string;
}

function docId(userId: string, bssid: string): string {
  return `${userId}::${bssid}`;
}

function docToNetwork(doc: NetworkDoc): KnownNetwork {
  return {
    bssid: doc.bssid,
    ssid: doc.ssid,
    placeObservations: (doc.place_observations ?? []).map((o) => ({
      placeId: o.place_id,
      placeName: o.place_name,
      count: o.count,
      lastSeen: o.last_seen,
    })),
    manualPlaceId: doc.manual_place_id,
    manualPlaceName: doc.manual_place_name,
    label: doc.label,
    totalObservations: doc.total_observations,
    firstSeen: doc.first_seen,
    lastSeen: doc.last_seen,
    createdAt: doc.created_at,
    updatedAt: doc.updated_at,
  };
}

export class ElasticsearchNetworkRepository
  extends BaseElasticsearchRepository
  implements NetworkRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getByBssid(userId: string, bssid: string): Promise<KnownNetwork | null> {
    try {
      const got = await this.client.get<NetworkDoc>({ index: INDEX, id: docId(userId, bssid) });
      const src = got._source;
      if (!src || src.user_id !== userId) return null;
      return docToNetwork(src);
    } catch (err: unknown) {
      const e = err as { meta?: { statusCode?: number } };
      if (e.meta?.statusCode === 404) return null;
      throw err;
    }
  }

  async list(userId: string, limit: number = 100): Promise<KnownNetwork[]> {
    const { hits } = await this.searchDocs<NetworkDoc>(userId, {
      filters: [],
      size: limit,
      sort: [{ last_seen: { order: 'desc' } }],
    });

    return hits.filter((h) => h._source != null).map((h) => docToNetwork(h._source!));
  }

  async resolvePlaceByBssid(userId: string, bssid: string): Promise<ResolvedPlaceForBssid | null> {
    const network = await this.getByBssid(userId, bssid);
    if (!network) return null;

    if (network.manualPlaceId && network.manualPlaceName) {
      return {
        placeId: network.manualPlaceId,
        placeName: network.manualPlaceName,
        source: 'manual',
        confidence: 1,
        observationCount: network.totalObservations,
        totalObservations: network.totalObservations,
        lastSeen: network.lastSeen,
        ssid: network.ssid,
      };
    }

    if (network.placeObservations.length === 0) return null;

    // Pick the dominant place by count
    const dominant = [...network.placeObservations].sort((a, b) => b.count - a.count)[0];
    if (dominant.count < MIN_AUTO_OBSERVATIONS) return null;

    const totalForObs = network.placeObservations.reduce((sum, o) => sum + o.count, 0);
    const confidence = Math.min(1, dominant.count / Math.max(totalForObs, 1));

    return {
      placeId: dominant.placeId,
      placeName: dominant.placeName,
      source: 'auto',
      confidence,
      observationCount: dominant.count,
      totalObservations: network.totalObservations,
      lastSeen: dominant.lastSeen,
      ssid: network.ssid,
    };
  }

  async setManualPlace(
    userId: string,
    bssid: string,
    placeId: string,
    placeName: string,
    label?: string,
  ): Promise<KnownNetwork> {
    const id = docId(userId, bssid);
    const now = this.nowISO();
    const existing = await this.getByBssid(userId, bssid);

    const doc: NetworkDoc = {
      user_id: userId,
      bssid,
      ssid: existing?.ssid,
      place_observations: (existing?.placeObservations ?? []).map((o): {
        place_id: string;
        place_name: string;
        count: number;
        last_seen: string;
      } => ({
        place_id: o.placeId,
        place_name: o.placeName,
        count: o.count,
        last_seen: o.lastSeen,
      })),
      manual_place_id: placeId,
      manual_place_name: placeName,
      label: label ?? existing?.label,
      total_observations: existing?.totalObservations ?? 0,
      first_seen: existing?.firstSeen ?? now,
      last_seen: existing?.lastSeen ?? now,
      created_at: existing?.createdAt ?? now,
      updated_at: now,
    };

    await this.client.index({
      index: INDEX,
      id,
      document: doc as unknown as Record<string, unknown>,
      refresh: true,
    });

    return docToNetwork(doc);
  }

  async clearManualPlace(userId: string, bssid: string): Promise<boolean> {
    const existing = await this.getByBssid(userId, bssid);
    if (!existing || !existing.manualPlaceId) return false;

    const id = docId(userId, bssid);
    const now = this.nowISO();
    const doc: NetworkDoc = {
      user_id: userId,
      bssid,
      ssid: existing.ssid,
      place_observations: (existing.placeObservations ?? []).map((o): {
        place_id: string;
        place_name: string;
        count: number;
        last_seen: string;
      } => ({
        place_id: o.placeId,
        place_name: o.placeName,
        count: o.count,
        last_seen: o.lastSeen,
      })),
      manual_place_id: undefined,
      manual_place_name: undefined,
      label: existing.label,
      total_observations: existing.totalObservations,
      first_seen: existing.firstSeen,
      last_seen: existing.lastSeen,
      created_at: existing.createdAt,
      updated_at: now,
    };

    await this.client.index({
      index: INDEX,
      id,
      document: doc as unknown as Record<string, unknown>,
      refresh: true,
    });
    return true;
  }
}
