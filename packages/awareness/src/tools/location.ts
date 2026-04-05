import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import { computeFreshness } from '../types/location.js';
import type { LocationWithFreshness } from '../types/location.js';

export function registerLocationTools(
  server: McpServer,
  locationRepo: LocationRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_current_location',
    'Returns the most recent GPS fix for the user, enriched with matched place name and a freshness indicator.',
    {},
    async () => {
      const userId = getUserId();
      const latest = await locationRepo.getLatest(userId);

      if (!latest) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'No location data available' }),
            },
          ],
          isError: true,
        };
      }

      const result: LocationWithFreshness = {
        lat: latest.location.lat,
        lon: latest.location.lon,
        accuracy: latest.accuracy,
        timestamp: latest.timestamp,
        freshness: computeFreshness(latest.timestamp),
        place_name: latest.matchedPlace ?? null,
        place_type: null,
        address: latest.address ?? null,
      };

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ location: result }),
          },
        ],
      };
    },
  );

  server.tool(
    'query_location_history',
    'Queries GPS history over a time range, with optional place filter. Returns location points sorted by timestamp descending.',
    {
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      place_filter: z.string().optional().describe('Filter by place name (fuzzy match)'),
      place_type_filter: z.string().optional().describe('Filter by place type (exact match)'),
      limit: z.number().min(1).max(500).optional().describe('Max results. Default: 100'),
    },
    async (params) => {
      const userId = getUserId();
      const locations = await locationRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        placeId: params.place_filter,
        limit: params.limit ?? 100,
      });

      const results = locations.map((loc) => ({
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
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true, id: params.id, reason: params.reason ?? null }) }],
      };
    },
  );
}
