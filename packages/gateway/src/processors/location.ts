import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { PushLocationItem } from '../types/index.js';
import { reverseGeocode } from '../utils/geocoding.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage } from '../utils/system-message.js';
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

interface PreviousLocationHit {
  _source?: {
    location?: { lat: number; lon: number };
    address?: string;
    matched_place?: string;
    timestamp?: string;
  };
}

/**
 * Haversine distance between two points in km.
 */
function haversine(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      sinLon *
      sinLon;
  return 2 * R * Math.asin(Math.sqrt(h));
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
    logger.warn('[location][matchKnownPlace] Place matching failed', {
      error: err instanceof Error ? err.message : String(err),
      lat,
      lon,
    });
    return null;
  }
}

/**
 * Query the previous location point from ES.
 * Returns the most recent point before the current one.
 */
async function getPreviousLocation(
  es: Client,
  userId: string,
): Promise<PreviousLocationHit['_source'] | null> {
  try {
    const response = await es.search({
      index: 'll5_awareness_locations',
      query: {
        bool: {
          filter: [{ term: { user_id: userId } }],
        },
      },
      sort: [{ timestamp: { order: 'desc' } }],
      size: 1,
    });

    const hits = response.hits.hits as PreviousLocationHit[];
    if (hits.length > 0 && hits[0]._source?.location) {
      return hits[0]._source;
    }
    return null;
  } catch (err) {
    logger.warn('[location][getPreviousLocation] Failed to query previous location', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Format distance for human-readable display.
 */
function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)}m`;
  return `${km.toFixed(1)}km`;
}

/**
 * Detect meaningful movement and push a system chat message.
 * Non-blocking: runs as fire-and-forget, does not slow the webhook response.
 *
 * Rules:
 * - Only triggers if distance > 200m
 * - Only triggers if previous point is within the last hour (not stale)
 */
function detectMovementAndNotify(
  es: Client,
  pool: Pool,
  userId: string,
  item: PushLocationItem,
  currentAddress: string | undefined,
  currentPlaceMatch: PlaceMatchResult | null,
): void {
  // Fire-and-forget: wrap in an immediately-invoked async and catch errors
  void (async () => {
    try {
      const prev = await getPreviousLocation(es, userId);
      if (!prev?.location || !prev.timestamp) return;

      // Check staleness: skip if previous point is older than 1 hour
      const prevTime = new Date(prev.timestamp).getTime();
      const currentTime = new Date(item.timestamp).getTime();
      const hourMs = 60 * 60 * 1000;
      if (currentTime - prevTime > hourMs) {
        logger.debug('[location][detectMovementAndNotify] Previous location too old for movement detection', {
          prevTimestamp: prev.timestamp,
          currentTimestamp: item.timestamp,
        });
        return;
      }

      // Calculate distance
      const dist = haversine(prev.location, { lat: item.lat, lon: item.lon });

      // Only notify for moves > 200m
      if (dist < 0.2) return;

      // Build human-readable message
      const prevLabel = prev.matched_place
        ? prev.matched_place
        : prev.address
          ? prev.address
          : `${prev.location.lat.toFixed(4)}, ${prev.location.lon.toFixed(4)}`;

      let newLabel: string;
      let arrivalContext = '';

      if (currentPlaceMatch) {
        newLabel = currentPlaceMatch.place_name;
        arrivalContext = ` User arrived at ${currentPlaceMatch.place_name}.`;
      } else if (currentAddress) {
        newLabel = currentAddress;
        arrivalContext = ` User is near ${currentAddress}.`;
      } else {
        newLabel = `${item.lat.toFixed(4)}, ${item.lon.toFixed(4)}`;
        arrivalContext = '';
      }

      const time = new Date(item.timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      });

      const content = `Location change detected: User moved ${formatDistance(dist)} from [${prevLabel}] to [${newLabel}] at ${time}.${arrivalContext}`;

      await insertSystemMessage(pool, userId, content);

      logger.info('[location][detectMovementAndNotify] Movement detected, system message sent', {
        distance: formatDistance(dist),
        from: prevLabel,
        to: newLabel,
      });
    } catch (err) {
      logger.warn('[location][detectMovementAndNotify] Movement detection failed (non-blocking)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
}

/**
 * Process a location push item:
 * 1. Reverse geocode lat/lon to address
 * 2. Match against known places
 * 3. Write to ll5_awareness_locations
 * 4. If place matched, write notable event
 * 5. Detect movement and push system notification (non-blocking)
 */
export async function processLocation(
  es: Client,
  userId: string,
  item: PushLocationItem,
  geocodingApiKey?: string,
  pgPool?: Pool,
): Promise<void> {
  // Filter out low-accuracy GPS points (e.g. indoor drift, cell tower fallback)
  const MIN_ACCURACY_METERS = 100;
  if (item.accuracy != null && item.accuracy > MIN_ACCURACY_METERS) {
    logger.debug('[processLocation][handle] Skipping low-accuracy GPS point', {
      accuracy: item.accuracy,
      threshold: MIN_ACCURACY_METERS,
      lat: item.lat,
      lon: item.lon,
    });
    return;
  }

  // Filter out GPS drift: if the previous point was at a known place and
  // less than 10 minutes ago, and the new point is >500m away but speed
  // would require >150km/h, it's likely a GPS glitch.
  try {
    const prev = await getPreviousLocation(es, userId);
    if (prev?.location && prev.timestamp) {
      const distKm = haversine(prev.location.lat, prev.location.lon, item.lat, item.lon);
      const timeDiffMs = new Date(item.timestamp).getTime() - new Date(prev.timestamp).getTime();
      const timeDiffMin = timeDiffMs / 60000;

      // Only check for drift within a 10-minute window
      if (timeDiffMin > 0 && timeDiffMin < 10) {
        const speedKmh = distKm / (timeDiffMs / 3600000);

        // Case 1: Physically impossible speed (>150 km/h in city)
        if (speedKmh > 150) {
          logger.info('[processLocation][handle] Skipping implausible GPS jump', {
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin),
            speedKmh: Math.round(speedKmh),
          });
          return;
        }

        // Case 2: Previous was at a known place, new point is >500m away
        // but within 5 min — likely drift from a stationary position
        if (prev.matched_place && distKm > 0.5 && timeDiffMin < 5) {
          logger.info('[processLocation][handle] Skipping likely drift from known place', {
            place: prev.matched_place,
            distKm: Math.round(distKm * 10) / 10,
            timeDiffMin: Math.round(timeDiffMin),
          });
          return;
        }
      }
    }
  } catch {
    // Non-critical — continue processing if plausibility check fails
  }

  // Run geocoding and place matching concurrently (both non-blocking)
  const [geocodeResult, placeMatch] = await Promise.all([
    reverseGeocode(item.lat, item.lon, geocodingApiKey),
    matchKnownPlace(es, userId, item.lat, item.lon),
  ]);

  // Fire off movement detection BEFORE writing the new point
  // (so getPreviousLocation gets the actual previous point, not this one)
  if (pgPool) {
    detectMovementAndNotify(
      es,
      pgPool,
      userId,
      item,
      geocodeResult?.address,
      placeMatch,
    );
  }

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

  logger.debug('[location][processLocation] Location stored', {
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
