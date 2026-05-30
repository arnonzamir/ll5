import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import { computeFreshness } from '../types/location.js';
import type { LocationService } from '../services/location-service.js';
import {
  detectStayPoints,
  groupVisitsIntoCandidates,
  type StayPointInput,
  type StayPointParams,
} from '../services/stay-point-service.js';
import { logAudit, formatTime, sessionTimezone } from '@ll5/shared';
import { logger } from '../utils/logger.js';

const KNOWN_PLACE_RADIUS_M = 100;

/**
 * True if any ll5_knowledge_places doc lies within KNOWN_PLACE_RADIUS_M of the
 * centroid. Reuses the same geo_distance query pattern the place repository
 * uses. Fail-open on ES error (treat as unknown) so a transient ES blip never
 * silently drops a real candidate — but the error is logged.
 */
async function centroidIsKnownPlace(
  es: Client,
  userId: string,
  centroid: { lat: number; lon: number },
): Promise<boolean> {
  try {
    const res = await es.search({
      index: 'll5_knowledge_places',
      size: 1,
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            {
              geo_distance: {
                distance: `${KNOWN_PLACE_RADIUS_M}m`,
                geo: { lat: centroid.lat, lon: centroid.lon },
              },
            },
          ],
        },
      } as unknown as Record<string, unknown>,
    });
    const total = res.hits.hits.length;
    return total > 0;
  } catch (err) {
    logger.warn('[location][centroidIsKnownPlace] place lookup failed; treating as unknown', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export function registerLocationTools(
  server: McpServer,
  locationRepo: LocationRepository,
  getUserId: () => string,
  locationService: LocationService,
  esClient?: Client,
): void {
  server.tool(
    'get_current_location',
    'Fused current-location answer (GPS + wifi BSSID). Returns the inferred place with confidence and provenance. Also includes raw GPS fields for backward compatibility.',
    {},
    async () => {
      const userId = getUserId();
      const fused = await locationService.getCurrentLocation(userId);

      if (fused.source === 'none') {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'No location data available' }) },
          ],
          isError: true,
        };
      }

      // Preserve legacy shape: lat/lon/accuracy/timestamp/place_name/address/freshness
      const gps = fused.gps;
      const legacy = gps
        ? {
            lat: gps.lat,
            lon: gps.lon,
            accuracy: gps.accuracy_m ?? null,
            timestamp: new Date(Date.now() - gps.age_s * 1000).toISOString(),
            freshness: computeFreshness(new Date(Date.now() - gps.age_s * 1000).toISOString()),
            place_name: fused.place,
            place_type: null,
            address: gps.address ?? null,
          }
        : null;

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              location: legacy,
              fused: {
                place: fused.place,
                place_id: fused.place_id,
                confidence: fused.confidence,
                source: fused.source,
                reasoning: fused.reasoning,
                gps: fused.gps ?? null,
                wifi: fused.wifi ?? null,
              },
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'where_is_user',
    'Fused answer to "where is the user right now" from GPS + wifi signals. Returns place + confidence + reasoning. Preferred over get_current_location for decision-making.',
    {},
    async () => {
      const userId = getUserId();
      const fused = await locationService.getCurrentLocation(userId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(fused) },
        ],
      };
    },
  );

  server.tool(
    'query_location_history',
    'Queries GPS history over a time range, with optional place filter by ID. Returns location points sorted by timestamp descending.',
    {
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      place_id: z.string().optional().describe('Filter by matched place ID (exact UUID). Use find_place_by_name in personal-knowledge to resolve a name first.'),
      limit: z.number().min(1).max(500).optional().describe('Max results. Default: 100'),
    },
    async (params) => {
      const userId = getUserId();
      const locations = await locationRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        placeId: params.place_id,
        limit: params.limit ?? 100,
      });

      const tz = sessionTimezone();
      const results = locations.map((loc) => ({
        id: loc.id,
        lat: loc.location.lat,
        lon: loc.location.lon,
        accuracy: loc.accuracy,
        timestamp: loc.timestamp,
        timestamp_local: loc.timestamp ? formatTime(loc.timestamp, tz).local : null,
        place_name: loc.matchedPlace ?? null,
        place_type: null,
        address: loc.address ?? null,
        duration_minutes: null,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ locations: results, total: results.length, tz }),
          },
        ],
      };
    },
  );

  server.tool(
    'delete_location_point',
    'Delete a GPS location point by ID. Use when you identify erroneous GPS data (impossible jumps, indoor drift, etc.).',
    {
      id: z.string().describe('The location document ID to delete'),
      reason: z.string().optional().describe('Why this point is being deleted (logged for audit)'),
    },
    async (params) => {
      const userId = getUserId();
      const deleted = await locationRepo.delete(userId, params.id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Location point not found or already deleted' }) }],
          isError: true,
        };
      }

      logAudit({
        user_id: userId,
        source: 'awareness',
        action: 'delete',
        entity_type: 'location',
        entity_id: params.id,
        summary: `Deleted location point ${params.id}`,
        metadata: { reason: params.reason },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, id: params.id, reason: params.reason ?? null }) }],
      };
    },
  );

  server.tool(
    'query_visits',
    'Answer "where did I spend time" over a range as VISITS (dwell/stay-points) rather than raw GPS points. Fetches GPS history, clusters consecutive points that stayed in one spot long enough, and returns one entry per dwell with start/end/duration/centroid/place. Prefer this over query_location_history when the user asks about where they were or how long they stayed.',
    {
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      limit: z.number().min(1).max(5000).optional().describe('Max GPS points to fetch and cluster. Default: 1000'),
      stay_radius_m: z.number().min(10).max(2000).optional().describe('Override dwell radius in meters. Default: 150'),
      min_dwell_minutes: z.number().min(1).max(1440).optional().describe('Override minimum dwell duration in minutes. Default: 10'),
      max_gap_minutes: z.number().min(1).max(1440).optional().describe('Override max gap between consecutive points before a run breaks, in minutes. Default: 30'),
    },
    async (params) => {
      const userId = getUserId();
      const locations = await locationRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        limit: params.limit ?? 1000,
      });

      const inputs: StayPointInput[] = locations.map((loc) => ({
        lat: loc.location.lat,
        lon: loc.location.lon,
        timestamp: loc.timestamp,
        matched_place_id: loc.matchedPlaceId ?? null,
        matched_place: loc.matchedPlace ?? null,
      }));

      const overrides: StayPointParams = {};
      if (params.stay_radius_m != null) overrides.stayRadiusM = params.stay_radius_m;
      if (params.min_dwell_minutes != null) overrides.minDwellMs = params.min_dwell_minutes * 60_000;
      if (params.max_gap_minutes != null) overrides.maxGapMs = params.max_gap_minutes * 60_000;

      const visits = detectStayPoints(inputs, overrides);

      const tz = sessionTimezone();
      const results = visits.map((v) => ({
        centroid: v.centroid,
        start: v.start,
        start_local: formatTime(v.start, tz).local,
        end: v.end,
        end_local: formatTime(v.end, tz).local,
        duration_minutes: v.duration_minutes,
        point_count: v.point_count,
        place_id: v.matched_place_id ?? null,
        place_name: v.matched_place ?? null,
      }));

      logger.info('[location][query_visits] clustered range into visits', {
        user_id: userId,
        points: inputs.length,
        visits: results.length,
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ visits: results, total: results.length, tz }) },
        ],
      };
    },
  );

  server.tool(
    'suggest_frequent_places',
    'Surface frequently-visited UNKNOWN locations as candidate places to save. Clusters GPS over a longer window into visits, groups nearby visits across days, EXCLUDES anything already matching a known place, and returns the remaining recurring spots sorted by visit count. Lets you say "you have been to this unnamed spot 5 times — want to save it?".',
    {
      from: z.string().describe('Start of window (ISO 8601). Use a wide range, e.g. last 30-90 days.'),
      to: z.string().describe('End of window (ISO 8601)'),
      limit: z.number().min(1).max(20000).optional().describe('Max GPS points to fetch and cluster. Default: 5000'),
      min_visits: z.number().min(1).max(100).optional().describe('Minimum distinct visits for a location to be suggested. Default: 3'),
      stay_radius_m: z.number().min(10).max(2000).optional().describe('Override dwell radius in meters. Default: 150'),
      min_dwell_minutes: z.number().min(1).max(1440).optional().describe('Override minimum dwell duration in minutes. Default: 10'),
      max_gap_minutes: z.number().min(1).max(1440).optional().describe('Override max gap between consecutive points before a run breaks, in minutes. Default: 30'),
    },
    async (params) => {
      const userId = getUserId();
      const minVisits = params.min_visits ?? 3;

      const locations = await locationRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        limit: params.limit ?? 5000,
      });

      const inputs: StayPointInput[] = locations.map((loc) => ({
        lat: loc.location.lat,
        lon: loc.location.lon,
        timestamp: loc.timestamp,
        matched_place_id: loc.matchedPlaceId ?? null,
        matched_place: loc.matchedPlace ?? null,
      }));

      const overrides: StayPointParams = {};
      if (params.stay_radius_m != null) overrides.stayRadiusM = params.stay_radius_m;
      if (params.min_dwell_minutes != null) overrides.minDwellMs = params.min_dwell_minutes * 60_000;
      if (params.max_gap_minutes != null) overrides.maxGapMs = params.max_gap_minutes * 60_000;

      const visits = detectStayPoints(inputs, overrides);

      // Drop visits already at a known place (the dwell carried a matched place).
      const unknownVisits = visits.filter((v) => !v.matched_place_id && !v.matched_place);

      const candidates = groupVisitsIntoCandidates(unknownVisits, overrides.stayRadiusM);

      // Filter by min_visits, then exclude any centroid within 100m of a known
      // place (catches recurring spots near, but not exactly at, a saved place,
      // and visits whose individual points never got a matched_place stamped).
      const frequent = candidates.filter((c) => c.visit_count >= minVisits);

      const surviving: typeof frequent = [];
      for (const c of frequent) {
        if (esClient) {
          const known = await centroidIsKnownPlace(esClient, userId, c.centroid);
          if (known) continue;
        }
        surviving.push(c);
      }

      surviving.sort((a, b) => b.visit_count - a.visit_count);

      logger.info('[location][suggest_frequent_places] computed candidates', {
        user_id: userId,
        points: inputs.length,
        visits: visits.length,
        unknown_visits: unknownVisits.length,
        candidates_before_filter: candidates.length,
        candidates: surviving.length,
        min_visits: minVisits,
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ candidates: surviving, total: surviving.length }) },
        ],
      };
    },
  );
}
