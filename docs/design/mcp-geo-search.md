# Geo-Search — Add to Awareness MCP

## Decision: Not a New MCP

Geo-search doesn't warrant its own MCP. It's location intelligence — belongs in the awareness MCP alongside GPS locations, entity statuses, and situational context. Adding tools there avoids a new service, new deployment, new auth config.

## Tools

### `search_nearby`

Find points of interest near a location.

```typescript
{
  lat: number,           // Center latitude
  lon: number,           // Center longitude
  query?: string,        // "pharmacy", "restaurant", "coffee"
  radius_m?: number,     // Search radius in meters (default: 500, max: 5000)
  limit?: number,        // Max results (default: 10)
}
```

Returns: `{ results: Array<{ name, type, address, lat, lon, distance_m, opening_hours? }> }`

**API**: Nominatim + Overpass API (free, no key). Falls back gracefully if rate-limited.

### `get_location_context`

Enrich a lat/lon with neighborhood, city, country context.

```typescript
{
  lat: number,
  lon: number,
}
```

Returns: `{ neighborhood, city, district, country, postal_code }`

**API**: Nominatim reverse geocode (already used in gateway for location processing).

### `get_distance`

Calculate distance between two points or between current location and a known place.

```typescript
{
  from: { lat: number, lon: number } | { place_name: string },
  to: { lat: number, lon: number } | { place_name: string },
}
```

Returns: `{ distance_km, walking_minutes_approx, driving_minutes_approx }`

**Implementation**: Haversine formula for straight-line distance. Walking/driving are rough estimates (walking: 5km/h, driving: 30km/h city). No routing API needed — this is a personal assistant, not a navigation app.

If `place_name` is provided, resolves via `list_places` geo query.

## External APIs

| API | Use | Cost | Rate Limit |
|-----|-----|------|------------|
| Nominatim | Reverse geocode, address search | Free | 1 req/sec |
| Overpass API | POI search by type/name near location | Free | Reasonable use |

No Google APIs needed. If richer POI data is wanted later (ratings, photos, hours), Google Places can be added behind a feature flag.

## Integration Points

- **Location processor** (gateway): When user arrives at a new place, agent can call `search_nearby` to understand the area
- **Shopping list**: Agent cross-references `search_nearby(query: "supermarket")` with shopping list items
- **Calendar**: Agent checks distance to next meeting location
- **Known places**: `get_distance` resolves place names from `ll5_knowledge_places`

## Storage

No new indices. Results are ephemeral — the agent queries on demand. If a user likes a discovered place, the agent saves it via `upsert_place`.

## Rate Limiting

Shared Nominatim rate limiter (1 req/sec) already exists in gateway. The awareness MCP should use the same pattern — a module-level timestamp tracker with delay enforcement.
