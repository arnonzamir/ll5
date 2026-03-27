import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import { PLACE_TYPES } from '../types/place.js';

export function registerPlaceTools(
  server: McpServer,
  placeRepo: PlaceRepository,
  getUserId: () => string,
): void {
  server.tool(
    'list_places',
    'List places with optional filters including geo-distance search.',
    {
      type: z.enum(PLACE_TYPES).optional().describe('Filter by place type'),
      tags: z.array(z.string()).optional().describe('Filter by tags (AND logic)'),
      query: z.string().optional().describe('Free-text search across name, address, notes'),
      near: z
        .object({
          lat: z.number().min(-90).max(90).describe('Latitude'),
          lon: z.number().min(-180).max(180).describe('Longitude'),
          radius_km: z.number().min(0).describe('Radius in kilometers'),
        })
        .optional()
        .describe('Geo search: find places near a point'),
      limit: z.number().min(1).max(200).optional().describe('Max results. Default: 50'),
      offset: z.number().min(0).optional().describe('Pagination offset. Default: 0'),
    },
    async (params) => {
      const userId = getUserId();
      const result = await placeRepo.list(userId, {
        type: params.type,
        tags: params.tags,
        query: params.query,
        near: params.near
          ? { lat: params.near.lat, lon: params.near.lon, radiusKm: params.near.radius_km }
          : undefined,
        limit: params.limit,
        offset: params.offset,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ places: result.items, total: result.total }),
          },
        ],
      };
    },
  );

  server.tool(
    'get_place',
    'Retrieve a single place by ID.',
    {
      id: z.string().describe('Place ID'),
    },
    async (params) => {
      const userId = getUserId();
      const place = await placeRepo.get(userId, params.id);
      if (!place) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Place not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ place }) }],
      };
    },
  );

  server.tool(
    'upsert_place',
    'Create or update a place.',
    {
      id: z.string().optional().describe('Place ID to update. Omit to create new.'),
      name: z.string().describe('Place name'),
      type: z.enum(PLACE_TYPES).describe('Place type'),
      address: z.string().optional().describe('Full address text'),
      lat: z.number().min(-90).max(90).optional().describe('Latitude'),
      lon: z.number().min(-180).max(180).optional().describe('Longitude'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      notes: z.string().optional().describe('Free-text notes'),
    },
    async (params) => {
      const userId = getUserId();
      const geo =
        params.lat !== undefined && params.lon !== undefined
          ? { lat: params.lat, lon: params.lon }
          : undefined;
      const result = await placeRepo.upsert(userId, {
        id: params.id,
        name: params.name,
        type: params.type,
        address: params.address,
        geo,
        tags: params.tags,
        notes: params.notes,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ place: result.place, created: result.created }),
          },
        ],
      };
    },
  );

  server.tool(
    'delete_place',
    'Delete a place by ID.',
    {
      id: z.string().describe('Place ID'),
    },
    async (params) => {
      const userId = getUserId();
      const deleted = await placeRepo.delete(userId, params.id);
      if (!deleted) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Place not found' }) }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ deleted: true }) }],
      };
    },
  );
}
