import { logger } from './logger.js';

export interface GeocodingResult {
  address: string;
  neighborhood?: string;
  city?: string;
  country?: string;
}

/**
 * Rate limiter for Nominatim: max 1 request per second.
 * Tracks the last request timestamp and delays if needed.
 */
let lastNominatimRequest = 0;

async function enforceNominatimRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastNominatimRequest;
  if (elapsed < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastNominatimRequest = Date.now();
}

interface NominatimAddress {
  road?: string;
  house_number?: string;
  neighbourhood?: string;
  suburb?: string;
  city?: string;
  town?: string;
  village?: string;
  county?: string;
  state?: string;
  country?: string;
}

interface NominatimResponse {
  display_name?: string;
  address?: NominatimAddress;
  error?: string;
}

/**
 * Reverse geocode using Nominatim (free, no API key).
 */
async function reverseGeocodeNominatim(lat: number, lon: number): Promise<GeocodingResult | null> {
  await enforceNominatimRateLimit();

  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'll5-gateway/0.1.0',
      'Accept-Language': 'en',
    },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    logger.warn('Nominatim returned non-OK status', { status: response.status, lat, lon });
    return null;
  }

  const data = (await response.json()) as NominatimResponse;

  if (data.error) {
    logger.warn('Nominatim returned error', { error: data.error, lat, lon });
    return null;
  }

  const addr = data.address;
  const city = addr?.city ?? addr?.town ?? addr?.village ?? undefined;

  return {
    address: data.display_name ?? '',
    neighborhood: addr?.neighbourhood ?? addr?.suburb ?? undefined,
    city,
    country: addr?.country ?? undefined,
  };
}

interface GoogleGeocodingResult {
  formatted_address?: string;
  address_components?: Array<{
    long_name: string;
    types: string[];
  }>;
}

interface GoogleGeocodingResponse {
  status: string;
  results?: GoogleGeocodingResult[];
}

/**
 * Reverse geocode using Google Geocoding API.
 */
async function reverseGeocodeGoogle(lat: number, lon: number, apiKey: string): Promise<GeocodingResult | null> {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&key=${apiKey}`;

  const response = await fetch(url, {
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    logger.warn('Google Geocoding returned non-OK status', { status: response.status, lat, lon });
    return null;
  }

  const data = (await response.json()) as GoogleGeocodingResponse;

  if (data.status !== 'OK' || !data.results?.length) {
    logger.warn('Google Geocoding returned no results', { status: data.status, lat, lon });
    return null;
  }

  const result = data.results[0];
  const components = result.address_components ?? [];

  function findComponent(type: string): string | undefined {
    return components.find((c) => c.types.includes(type))?.long_name;
  }

  return {
    address: result.formatted_address ?? '',
    neighborhood: findComponent('neighborhood') ?? findComponent('sublocality'),
    city: findComponent('locality'),
    country: findComponent('country'),
  };
}

/**
 * Reverse geocode a lat/lon pair. Uses Google if API key is available, otherwise Nominatim.
 * Returns null on failure (non-blocking).
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
  googleApiKey?: string,
): Promise<GeocodingResult | null> {
  try {
    if (googleApiKey) {
      return await reverseGeocodeGoogle(lat, lon, googleApiKey);
    }
    return await reverseGeocodeNominatim(lat, lon);
  } catch (err) {
    logger.warn('Reverse geocoding failed', {
      lat,
      lon,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
