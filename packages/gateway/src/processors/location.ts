import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { PushLocationItem } from '../types/index.js';
import { reverseGeocode } from '../utils/geocoding.js';
import { logger } from '../utils/logger.js';
import { writeNotableEvent } from './notable.js';

interface PlaceHit {
  _id?: string;
  _source?: {
    name?: string;
    user_id?: string;
  };
}

interface PlaceMatchResult {
  place_id: string;
  place_name: string;
}

/**
 * Query ll5_knowledge_places for a known place within 100m of the given coordinates.
 */
async function matchKnownPlace(
  es: Client,
  userId: string,
  lat: number,
  lon: number,
): Promise<PlaceMatchResult | null> {
  try {
    const response = await es.search({
      index: 'll5_knowledge_places',
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            {
              geo_distance: {
                distance: '100m',
                geo: { lat, lon },
              },
            },
          ],
        },
      },
      size: 1,
    });

    const hits = response.hits.hits as PlaceHit[];
    if (hits.length > 0 && hits[0]._id && hits[0]._source?.name) {
      return {
        place_id: hits[0]._id,
        place_name: hits[0]._source.name,
      };
    }

    return null;
  } catch (err) {
    logger.warn('Place matching failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
    });
    return null;
  }
}

/**
 * Process a location push item:
 * 1. Reverse geocode lat/lon to address
 * 2. Match against known places
 * 3. Write to ll5_awareness_locations
 * 4. If place matched, write notable event
 */
export async function processLocation(
  es: Client,
  userId: string,
  item: PushLocationItem,
  geocodingApiKey?: string,
): Promise<void> {
  // Run geocoding and place matching concurrently (both non-blocking)
  const [geocodeResult, placeMatch] = await Promise.all([
    reverseGeocode(item.lat, item.lon, geocodingApiKey),
    matchKnownPlace(es, userId, item.lat, item.lon),
  ]);

  // Build the location document
  const doc: Record<string, unknown> = {
    user_id: userId,
    location: { lat: item.lat, lon: item.lon },
    timestamp: item.timestamp,
  };

  if (item.accuracy_m !== undefined) {
    doc.accuracy = item.accuracy_m;
  }

  if (item.battery_pct !== undefined) {
    doc.battery_pct = item.battery_pct;
  }

  if (geocodeResult) {
    doc.address = geocodeResult.address;
  }

  if (placeMatch) {
    doc.matched_place_id = placeMatch.place_id;
    doc.matched_place = placeMatch.place_name;
  }

  // Write location document
  await es.index({
    index: 'll5_awareness_locations',
    id: crypto.randomUUID(),
    document: doc,
    refresh: false,
  });

  logger.debug('Location stored', {
    lat: item.lat,
    lon: item.lon,
    address: geocodeResult?.address,
    matched_place: placeMatch?.place_name,
  });

  // If place matched, write a notable event
  if (placeMatch) {
    await writeNotableEvent(es, userId, {
      event_type: 'arrived_at_place',
      timestamp: item.timestamp,
      place_id: placeMatch.place_id,
      place_name: placeMatch.place_name,
      location: { lat: item.lat, lon: item.lon },
    });
  }
}
