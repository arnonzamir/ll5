import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import { computeFreshness } from '../types/location.js';
import type { LocationService } from '../services/location-service.js';
import { logAudit } from '@ll5/shared';

export function registerLocationTools(
  server: McpServer,
  locationRepo: LocationRepository,
  getUserId: () => string,
  locationService: LocationService,
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

      const results = locations.map((loc) => ({
        id: loc.id,
        lat: loc.location.lat,
        lon: loc.location.lon,
        accuracy: loc.accuracy,
        timestamp: loc.timestamp,
        place_name: loc.matchedPlace ?? null,
        place_type: null,
        address: loc.address ?? null,
        duration_minutes: null,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ locations: results, total: results.length }),
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
}
