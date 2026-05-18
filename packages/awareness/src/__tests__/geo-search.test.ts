import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @ll5/shared upfront — geo-search tools don't actually call shared, but
// the awareness package may be wired such that other imports pull it in.
vi.mock('@ll5/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@ll5/shared');
  return {
    ...actual,
    logAudit: vi.fn(),
  };
});

import { registerGeoSearchTools, resetNominatimRateLimitForTests } from '../tools/geo-search.js';
import { haversineDistance } from '../utils/geo.js';
import { captureTools, parseToolResponse } from './_helpers.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

// ---------------------------------------------------------------------------
// Pure helper — haversineDistance
// ---------------------------------------------------------------------------

describe('haversineDistance', () => {
  it('returns 0 for identical points', () => {
    expect(haversineDistance(32.0853, 34.7818, 32.0853, 34.7818)).toBe(0);
  });

  it('NYC → LA ≈ 3,935 km (within 1%)', () => {
    // NYC: 40.7128, -74.0060   LA: 34.0522, -118.2437
    const d = haversineDistance(40.7128, -74.0060, 34.0522, -118.2437);
    const km = d / 1000;
    expect(km).toBeGreaterThan(3900);
    expect(km).toBeLessThan(3970);
  });

  it('London → Paris ≈ 344 km (within 1%)', () => {
    const d = haversineDistance(51.5074, -0.1278, 48.8566, 2.3522);
    const km = d / 1000;
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(348);
  });

  it('is symmetric (a → b == b → a)', () => {
    const a = haversineDistance(32, 34, 40, -70);
    const b = haversineDistance(40, -70, 32, 34);
    expect(a).toBeCloseTo(b, 6);
  });

  it('returns a small distance (<200m) for points ~100m apart', () => {
    // ~0.001 deg latitude ≈ 111m
    const d = haversineDistance(32.0853, 34.7818, 32.0863, 34.7818);
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });

  it('antipodes are roughly half Earth circumference (~20,015 km)', () => {
    const d = haversineDistance(0, 0, 0, 180) / 1000;
    expect(d).toBeGreaterThan(20_000);
    expect(d).toBeLessThan(20_100);
  });
});

// ---------------------------------------------------------------------------
// Tool tests — mock fetch
// ---------------------------------------------------------------------------

type FetchMock = ReturnType<typeof vi.fn>;
let fetchSpy: FetchMock;

function mockJsonResponse(data: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  // Reset the module-local Nominatim rate-limiter state so the 1.1s gate
  // doesn't serialize across tests (state-leak between cases is the only
  // reason these were taking >25s in aggregate before).
  resetNominatimRateLimitForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// search_nearby_pois
// ---------------------------------------------------------------------------

describe('search_nearby_pois tool handler', () => {
  it('returns an error envelope when neither query nor category is provided', async () => {
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818,
    });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Provide either query or category/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('builds an Overpass POST body for a known category and parses elements', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({
      elements: [
        { lat: 32.0860, lon: 34.7820, tags: { name: 'Super Pharm', 'addr:street': 'Rothschild', 'addr:housenumber': '12' } },
        { lat: 32.0900, lon: 34.7830, tags: { name: 'Pharma 24', 'addr:street': 'Allenby' } },
      ],
    }));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818, category: 'pharmacy', radius_m: 500, limit: 10,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://overpass-api.de/api/interpreter');
    expect((init as RequestInit).method).toBe('POST');
    const body = String((init as RequestInit).body);
    // pharmacy maps to amenity=pharmacy with the right radius/center
    expect(body).toContain('amenity');
    expect(body).toContain('pharmacy');
    expect(body).toContain('around%3A500');
    expect(body).toContain('32.0853');

    const parsed = parseToolResponse<{ results: Array<{ name: string; distance_m: number }>; count: number }>(response);
    expect(parsed.count).toBe(2);
    // Results sorted by distance ascending
    expect(parsed.results[0].name).toBe('Super Pharm');
    expect(parsed.results[0].distance_m).toBeGreaterThan(0);
    expect(parsed.results[0].distance_m).toBeLessThanOrEqual(parsed.results[1].distance_m);
  });

  it('uses category name as fallback when element has no name tag', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({
      elements: [{ lat: 32.0860, lon: 34.7820, tags: {} }],
    }));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818, category: 'gym',
    });
    const parsed = parseToolResponse<{ results: Array<{ name: string }> }>(response);
    expect(parsed.results[0].name).toBe('gym');
  });

  it('falls back to Nominatim when query is provided (no category match)', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([
      { lat: '32.0860', lon: '34.7820', display_name: 'Italian Place, Tel Aviv', type: 'restaurant', class: 'amenity' },
    ]));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818, query: 'italian restaurant', radius_m: 500,
    });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/nominatim\.openstreetmap\.org\/search/);
    expect(String(url)).toMatch(/q=italian%20restaurant/);
    expect(String(url)).toMatch(/bounded=1/);
    // Nominatim requires a User-Agent
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('ll5') });

    const parsed = parseToolResponse<{ results: Array<{ name: string; category: string; lat: number; lon: number }>; count: number }>(response);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].name).toBe('Italian Place');
    expect(parsed.results[0].lat).toBeCloseTo(32.0860, 4);
  }, 10_000);

  it('handles Overpass failure (non-ok response) by returning empty results', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({}, false, 503));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818, category: 'pharmacy',
    });

    // Tool swallows non-ok and returns an empty result set (no isError)
    expect(response.isError).toBeUndefined();
    const parsed = parseToolResponse<{ results: unknown[]; count: number }>(response);
    expect(parsed.count).toBe(0);
  });

  it('returns isError envelope when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('search_nearby_pois')!({
      lat: 32.0853, lon: 34.7818, category: 'pharmacy',
    });

    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/network down/);
  });
});

// ---------------------------------------------------------------------------
// geocode_address
// ---------------------------------------------------------------------------

describe('geocode_address tool handler', () => {
  it('hits Nominatim /search and maps results to {lat, lon, display_name, type, confidence}', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([
      { lat: '32.1133', lon: '34.8044', display_name: 'Tel Aviv University, Tel Aviv', type: 'university', importance: 0.82 },
    ]));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('geocode_address')!({ address: 'Tel Aviv University' });

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/nominatim\.openstreetmap\.org\/search/);
    expect(String(url)).toMatch(/q=Tel%20Aviv%20University/);
    expect(String(url)).toMatch(/addressdetails=1/);
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('ll5') });

    const parsed = parseToolResponse<{ results: Array<{ lat: number; lon: number; display_name: string; confidence: number }>; count: number }>(response);
    expect(parsed.count).toBe(1);
    expect(parsed.results[0].lat).toBeCloseTo(32.1133, 4);
    expect(parsed.results[0].confidence).toBe(0.82);
  }, 10_000);

  it('adds viewbox bias when near_lat/near_lon are provided', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse([]));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    await tools.get('geocode_address')!({
      address: 'pharmacy',
      near_lat: 32.0853,
      near_lon: 34.7818,
    });
    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/viewbox=/);
    expect(String(url)).toMatch(/bounded=0/);
  }, 10_000);

  it('returns isError on non-ok Nominatim status', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({}, false, 429));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('geocode_address')!({ address: 'X' });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Nominatim error: 429/);
  }, 10_000);

  it('returns isError when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('dns failure'));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('geocode_address')!({ address: 'X' });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/dns failure/);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// get_area_context
// ---------------------------------------------------------------------------

describe('get_area_context tool handler', () => {
  it('hits Nominatim /reverse and extracts neighborhood/city/country fields', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({
      display_name: '12 Rothschild, Tel Aviv, Israel',
      address: {
        road: 'Rothschild',
        neighbourhood: 'Lev HaIr',
        city: 'Tel Aviv',
        country: 'Israel',
        postcode: '6688112',
        county: 'Tel Aviv District',
      },
    }));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_area_context')!({ lat: 32.0853, lon: 34.7818 });

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/\/reverse\?format=json/);
    expect(String(url)).toMatch(/lat=32\.0853/);
    expect(String(url)).toMatch(/lon=34\.7818/);
    expect(String(url)).toMatch(/zoom=16/);

    const parsed = parseToolResponse<{ neighborhood: string; city: string; country: string; road: string }>(response);
    expect(parsed.neighborhood).toBe('Lev HaIr');
    expect(parsed.city).toBe('Tel Aviv');
    expect(parsed.country).toBe('Israel');
    expect(parsed.road).toBe('Rothschild');
  }, 10_000);

  it('falls back through suburb/town/village when neighborhood/city are missing', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({
      display_name: 'Somewhere',
      address: { suburb: 'OldTown', town: 'Smallville' },
    }));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_area_context')!({ lat: 0, lon: 0 });

    const parsed = parseToolResponse<{ neighborhood: string; city: string }>(response);
    expect(parsed.neighborhood).toBe('OldTown');
    expect(parsed.city).toBe('Smallville');
  }, 10_000);

  it('returns isError on non-ok response', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({}, false, 500));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_area_context')!({ lat: 0, lon: 0 });
    expect(response.isError).toBe(true);
    expect(parseToolResponse<{ error: string }>(response).error).toMatch(/Nominatim error: 500/);
  }, 10_000);

  it('returns isError when fetch throws', async () => {
    fetchSpy.mockRejectedValue(new Error('boom'));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_area_context')!({ lat: 0, lon: 0 });
    expect(response.isError).toBe(true);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// get_distance
// ---------------------------------------------------------------------------

describe('get_distance tool handler', () => {
  it('builds an OSRM URL with the right profile + coords and parses route.distance/duration', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({
      routes: [{ distance: 12_500, duration: 1_800 }],
    }));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_distance')!({
      origin_lat: 32.0853, origin_lon: 34.7818,
      dest_lat: 32.1500, dest_lon: 34.8500,
      mode: 'driving',
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(String(url)).toMatch(/router\.project-osrm\.org\/route\/v1\/car\//);
    expect(String(url)).toMatch(/34\.7818,32\.0853;34\.85,32\.15/);

    const parsed = parseToolResponse<{ distance_km: number; duration_minutes: number; mode: string; source: string }>(response);
    expect(parsed.distance_km).toBe(12.5);
    expect(parsed.duration_minutes).toBe(30);
    expect(parsed.mode).toBe('driving');
    expect(parsed.source).toBe('osrm');
  });

  it('maps cycling and walking to the right OSRM profile', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ routes: [{ distance: 1000, duration: 600 }] }));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));

    await tools.get('get_distance')!({ origin_lat: 0, origin_lon: 0, dest_lat: 0, dest_lon: 0.01, mode: 'cycling' });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/route\/v1\/bicycle\//);

    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(mockJsonResponse({ routes: [{ distance: 1000, duration: 600 }] }));
    await tools.get('get_distance')!({ origin_lat: 0, origin_lon: 0, dest_lat: 0, dest_lon: 0.01, mode: 'walking' });
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/route\/v1\/foot\//);
  });

  it('falls back to a haversine estimate when OSRM is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('osrm down'));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_distance')!({
      origin_lat: 40.7128, origin_lon: -74.0060,   // NYC
      dest_lat: 34.0522,   dest_lon: -118.2437,   // LA
      mode: 'driving',
    });

    const parsed = parseToolResponse<{ distance_km: number; mode: string; source: string }>(response);
    expect(parsed.source).toBe('haversine_estimate');
    expect(parsed.mode).toBe('driving');
    expect(parsed.distance_km).toBeGreaterThan(3900);
    expect(parsed.distance_km).toBeLessThan(3970);
  });

  it('falls back to haversine when OSRM returns no route', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ routes: [] }));

    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_distance')!({
      origin_lat: 0, origin_lon: 0,
      dest_lat: 0, dest_lon: 1,
    });

    const parsed = parseToolResponse<{ source: string }>(response);
    expect(parsed.source).toBe('haversine_estimate');
  });

  it('defaults mode to driving when not specified', async () => {
    fetchSpy.mockResolvedValue(mockJsonResponse({ routes: [{ distance: 100, duration: 30 }] }));
    const tools = captureTools((s) => registerGeoSearchTools(s, getUserId));
    const response = await tools.get('get_distance')!({
      origin_lat: 0, origin_lon: 0, dest_lat: 0, dest_lon: 0.001,
    });
    const parsed = parseToolResponse<{ mode: string }>(response);
    expect(parsed.mode).toBe('driving');
    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/route\/v1\/car\//);
  });
});
