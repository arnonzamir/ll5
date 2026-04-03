# Geo-Search MCP

## Decision: Separate MCP vs. Awareness Tools

**Separate MCP.** Reasons:
- **Different data source.** Awareness reads internal ES. Geo-search calls external APIs (Nominatim, Overpass). Mixing them violates separation of concerns.
- **Different failure modes.** External APIs have rate limits and downtime. A Nominatim outage shouldn't degrade location history queries.
- **Different caching.** POI data is semi-static and benefits from aggressive caching. Awareness data is real-time.

The agent orchestrates across MCPs — calls `get_current_location` on awareness, passes lat/lon to geo-search. Standard LL5 pattern.

## Tools

### `search_nearby_pois`

Find points of interest near a location.

```typescript
{
  lat: number,
  lon: number,
  query?: string,           // "pharmacy", "Italian restaurant"
  category?: string,        // "restaurant", "pharmacy", "supermarket", etc.
  radius_m?: number,        // Default: 500, max: 5000
  limit?: number,           // Default: 10, max: 25
}
```

Returns: `{ results: Array<{ name, category, lat, lon, distance_m, address, source }> }`

### `get_distance`

Calculate distance and travel time between two points.

```typescript
{
  origin_lat: number,
  origin_lon: number,
  dest_lat: number,
  dest_lon: number,
  mode?: "driving" | "walking" | "cycling",  // Default: driving
}
```

Returns: `{ distance_km, distance_text, duration_minutes, duration_text, mode, source }`

### `get_area_context`

Neighborhood/area context for a location.

```typescript
{
  lat: number,
  lon: number,
}
```

Returns: `{ neighborhood, suburb, city, country, postcode, address }`

### `geocode_address`

Convert address/place name to coordinates.

```typescript
{
  address: string,
  near_lat?: number,    // Bias results near this point
  near_lon?: number,
}
```

Returns: `{ results: Array<{ lat, lon, display_name, type, confidence }> }`

## External APIs

| API | Use | Cost | Rate Limit |
|-----|-----|------|------------|
| Nominatim | Reverse/forward geocode, area context | Free | 1 req/sec |
| Overpass API | POI search by type/name near location | Free | Reasonable use |
| OSRM | Distance/routing | Free (public demo) | Reasonable use |
| Google Places | POI with ratings/hours (optional) | Paid | Key required |

Primary: Nominatim + Overpass + OSRM (all free, no key). Google Places as optional upgrade behind `GOOGLE_PLACES_API_KEY` env var.

## Storage

### Response Cache: `ll5_geo_cache` (ES)

```
cache_key: keyword    // "poi:32.0853,34.7818:pharmacy:500"
response: object      // Cached API response
source: keyword       // "nominatim", "overpass", "osrm"
created_at: date
expires_at: date
```

TTL: 24 hours. POI data rarely changes. Cache prevents rate limit issues.

No user data stored — only external API responses keyed by coordinates.

## Integration Points

- **Location processor**: Agent calls `search_nearby` when user arrives at new area
- **Shopping list**: Agent cross-references `search_nearby(query: "supermarket")` with shopping items
- **Calendar**: Agent checks distance to next meeting location
- **Known places**: Agent resolves place names from personal-knowledge first, falls back to `geocode_address`
- **No direct MCP-to-MCP calls**: Agent is the orchestrator

## Deployment

- Package: `packages/geo-search/`
- Docker: shared `Dockerfile.mcp` with `PACKAGE_NAME=geo-search`
- URL: `https://mcp-geo-search.noninoni.click/mcp`
- Add to CI `PACKAGES` array, docker-compose, `.mcp.json`

## OSM Category Mapping

| Category | OSM Tags |
|----------|----------|
| restaurant | `amenity=restaurant` |
| cafe | `amenity=cafe` |
| pharmacy | `amenity=pharmacy` |
| supermarket | `shop=supermarket` |
| hospital | `amenity=hospital` |
| gym | `leisure=fitness_centre` |
| bank | `amenity=bank` |
| gas_station | `amenity=fuel` |
| post_office | `amenity=post_office` |
| parking | `amenity=parking` |
| bakery | `shop=bakery` |

For free-text `query`, use Nominatim search with coordinate bias, fall back to Overpass `name~"query"` filter.
