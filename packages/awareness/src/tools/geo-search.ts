import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../utils/logger.js';

/** Rate limiter for Nominatim: 1 req/sec */
let lastNominatimRequest = 0;
async function rateLimitNominatim(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNominatimRequest;
  if (elapsed < 1100) {
    await new Promise((r) => setTimeout(r, 1100 - elapsed));
  }
  lastNominatimRequest = Date.now();
}

const NOMINATIM_HEADERS = {
  'User-Agent': 'll5-awareness/0.1.0',
  'Accept-Language': 'en',
};

const OSM_CATEGORY_MAP: Record<string, string> = {
  restaurant: 'amenity=restaurant',
  cafe: 'amenity=cafe',
  bar: 'amenity=bar|amenity=pub',
  pharmacy: 'amenity=pharmacy',
  supermarket: 'shop=supermarket',
  gas_station: 'amenity=fuel',
  hospital: 'amenity=hospital',
  clinic: 'amenity=clinic|amenity=doctors',
  dentist: 'amenity=dentist',
  gym: 'leisure=fitness_centre',
  bank: 'amenity=bank',
  atm: 'amenity=atm',
  post_office: 'amenity=post_office',
  parking: 'amenity=parking',
  bakery: 'shop=bakery',
  park: 'leisure=park',
  dog_park: 'leisure=dog_park',
  playground: 'leisure=playground',
  school: 'amenity=school',
  kindergarten: 'amenity=kindergarten',
};

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function registerGeoSearchTools(
  server: McpServer,
  getUserId: () => string,
): void {
  // ---------------------------------------------------------------------------
  // search_nearby_pois
  // ---------------------------------------------------------------------------
  server.tool(
    'search_nearby_pois',
    'Find points of interest near a location. Use for "find a pharmacy near me", "dog parks within 1km", etc.',
    {
      lat: z.number().min(-90).max(90).describe('Center latitude'),
      lon: z.number().min(-180).max(180).describe('Center longitude'),
      query: z.string().optional().describe('Free-text search (e.g. "pharmacy", "Italian restaurant"). Mutually exclusive with category.'),
      category: z.string().optional().describe(`POI category. Options: ${Object.keys(OSM_CATEGORY_MAP).join(', ')}. Mutually exclusive with query.`),
      radius_m: z.number().min(100).max(5000).optional().describe('Search radius in meters. Default: 500'),
      limit: z.number().min(1).max(25).optional().describe('Max results. Default: 10'),
    },
    async (params) => {
      getUserId(); // auth check
      const radius = params.radius_m ?? 500;
      const limit = params.limit ?? 10;

      try {
        let results: Array<{ name: string; category: string; lat: number; lon: number; distance_m: number; address: string | null }> = [];

        if (params.category && OSM_CATEGORY_MAP[params.category]) {
          // Overpass API query for known category
          const tags = OSM_CATEGORY_MAP[params.category];
          const tagParts = tags.split('|').map((t) => {
            const [k, v] = t.split('=');
            return `node["${k}"="${v}"](around:${radius},${params.lat},${params.lon});`;
          });

          const overpassQuery = `[out:json][timeout:10];(${tagParts.join('')});out body ${limit};`;
          const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: `data=${encodeURIComponent(overpassQuery)}`,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            signal: AbortSignal.timeout(15000),
          });

          if (res.ok) {
            const data = await res.json() as { elements: Array<{ lat: number; lon: number; tags?: Record<string, string> }> };
            results = (data.elements || []).map((el) => ({
              name: el.tags?.name ?? el.tags?.['name:en'] ?? params.category ?? 'Unknown',
              category: params.category!,
              lat: el.lat,
              lon: el.lon,
              distance_m: Math.round(haversineDistance(params.lat, params.lon, el.lat, el.lon)),
              address: el.tags?.['addr:street'] ? `${el.tags['addr:street']} ${el.tags['addr:housenumber'] ?? ''}`.trim() : null,
            }));
          }
        } else if (params.query) {
          // Nominatim search with viewbox bias
          await rateLimitNominatim();
          const delta = radius / 111000; // rough degree offset
          const viewbox = `${params.lon - delta},${params.lat + delta},${params.lon + delta},${params.lat - delta}`;
          const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(params.query)}&viewbox=${viewbox}&bounded=1&limit=${limit}&addressdetails=1`;

          const res = await fetch(url, { headers: NOMINATIM_HEADERS, signal: AbortSignal.timeout(10000) });
          if (res.ok) {
            const data = await res.json() as Array<{ lat: string; lon: string; display_name: string; type: string; class: string }>;
            results = data.map((r) => ({
              name: r.display_name.split(',')[0],
              category: r.type || r.class || 'place',
              lat: parseFloat(r.lat),
              lon: parseFloat(r.lon),
              distance_m: Math.round(haversineDistance(params.lat, params.lon, parseFloat(r.lat), parseFloat(r.lon))),
              address: r.display_name,
            }));
          }
        } else {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Provide either query or category' }) }], isError: true };
        }

        // Sort by distance
        results.sort((a, b) => a.distance_m - b.distance_m);

        return { content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[search_nearby_pois] Failed', { error: msg });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // geocode_address
  // ---------------------------------------------------------------------------
  server.tool(
    'geocode_address',
    'Convert an address or place name to coordinates. "Tel Aviv University" → lat/lon.',
    {
      address: z.string().describe('Address or place name to geocode'),
      near_lat: z.number().optional().describe('Bias results near this latitude'),
      near_lon: z.number().optional().describe('Bias results near this longitude'),
    },
    async (params) => {
      getUserId();
      try {
        await rateLimitNominatim();
        let url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(params.address)}&limit=5&addressdetails=1`;
        if (params.near_lat != null && params.near_lon != null) {
          const delta = 0.5; // ~50km bias
          url += `&viewbox=${params.near_lon - delta},${params.near_lat + delta},${params.near_lon + delta},${params.near_lat - delta}&bounded=0`;
        }

        const res = await fetch(url, { headers: NOMINATIM_HEADERS, signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Nominatim error: ${res.status}` }) }], isError: true };
        }

        const data = await res.json() as Array<{ lat: string; lon: string; display_name: string; type: string; importance: number }>;
        const results = data.map((r) => ({
          lat: parseFloat(r.lat),
          lon: parseFloat(r.lon),
          display_name: r.display_name,
          type: r.type,
          confidence: Math.round(r.importance * 100) / 100,
        }));

        return { content: [{ type: 'text' as const, text: JSON.stringify({ results, count: results.length }) }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[geocode_address] Failed', { error: msg });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_area_context
  // ---------------------------------------------------------------------------
  server.tool(
    'get_area_context',
    'Get neighborhood/area context for a location. "What neighborhood am I in?"',
    {
      lat: z.number().min(-90).max(90).describe('Latitude'),
      lon: z.number().min(-180).max(180).describe('Longitude'),
    },
    async (params) => {
      getUserId();
      try {
        await rateLimitNominatim();
        const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${params.lat}&lon=${params.lon}&zoom=16&addressdetails=1`;
        const res = await fetch(url, { headers: NOMINATIM_HEADERS, signal: AbortSignal.timeout(10000) });
        if (!res.ok) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `Nominatim error: ${res.status}` }) }], isError: true };
        }

        const data = await res.json() as {
          display_name?: string;
          address?: {
            neighbourhood?: string;
            suburb?: string;
            city?: string;
            town?: string;
            village?: string;
            county?: string;
            country?: string;
            postcode?: string;
            road?: string;
          };
        };

        const addr = data.address;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              address: data.display_name ?? '',
              neighborhood: addr?.neighbourhood ?? addr?.suburb ?? null,
              city: addr?.city ?? addr?.town ?? addr?.village ?? null,
              county: addr?.county ?? null,
              country: addr?.country ?? null,
              postcode: addr?.postcode ?? null,
              road: addr?.road ?? null,
            }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[get_area_context] Failed', { error: msg });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }], isError: true };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_distance
  // ---------------------------------------------------------------------------
  server.tool(
    'get_distance',
    'Calculate distance and estimated travel time between two points.',
    {
      origin_lat: z.number().describe('Origin latitude'),
      origin_lon: z.number().describe('Origin longitude'),
      dest_lat: z.number().describe('Destination latitude'),
      dest_lon: z.number().describe('Destination longitude'),
      mode: z.enum(['driving', 'walking', 'cycling']).optional().describe('Travel mode. Default: driving'),
    },
    async (params) => {
      getUserId();
      const mode = params.mode ?? 'driving';

      // Haversine straight-line distance
      const straightLineM = haversineDistance(params.origin_lat, params.origin_lon, params.dest_lat, params.dest_lon);

      // Try OSRM for routed distance
      const osrmProfile = mode === 'driving' ? 'car' : mode === 'cycling' ? 'bicycle' : 'foot';
      try {
        const url = `https://router.project-osrm.org/route/v1/${osrmProfile}/${params.origin_lon},${params.origin_lat};${params.dest_lon},${params.dest_lat}?overview=false`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const data = await res.json() as { routes?: Array<{ distance: number; duration: number }> };
          const route = data.routes?.[0];
          if (route) {
            const km = Math.round(route.distance / 100) / 10;
            const mins = Math.round(route.duration / 60);
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  distance_km: km,
                  distance_text: km < 1 ? `${Math.round(route.distance)}m` : `${km} km`,
                  duration_minutes: mins,
                  duration_text: mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}min`,
                  mode,
                  source: 'osrm',
                }),
              }],
            };
          }
        }
      } catch {
        // Fall back to haversine estimate
      }

      // Haversine fallback with rough speed estimates
      const speeds = { driving: 30, walking: 5, cycling: 15 }; // km/h city average
      const km = Math.round(straightLineM / 100) / 10;
      const mins = Math.round((km / speeds[mode]) * 60);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            distance_km: km,
            distance_text: km < 1 ? `${Math.round(straightLineM)}m` : `${km} km`,
            duration_minutes: mins,
            duration_text: mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}min`,
            mode,
            source: 'haversine_estimate',
          }),
        }],
      };
    },
  );
}
