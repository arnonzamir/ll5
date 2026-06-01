import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { TrackedDeviceRepository } from '../repositories/interfaces/tracked-device.repository.js';
import type { TrackedDevice } from '../types/tracked-device.js';
import { computeFreshness } from '../types/tracked-device.js';

/**
 * Shape a TrackedDevice into the agent-facing answer. `place` collapses the
 * provenance into one human label, preferring a saved-place match, then
 * Google's semantic label, then the geocoded address, then raw coordinates.
 */
function presentDevice(d: TrackedDevice) {
  const ageMs = Date.now() - new Date(d.lastSeen).getTime();
  const place =
    d.matchedPlace ??
    d.semanticName ??
    d.address ??
    `${d.location.lat.toFixed(5)}, ${d.location.lon.toFixed(5)}`;

  return {
    name: d.name,
    device_type: d.deviceType,
    place,
    matched_place: d.matchedPlace ?? null,
    address: d.address ?? null,
    location: d.location,
    accuracy_m: d.accuracy ?? null,
    battery_pct: d.batteryPct ?? null,
    last_seen: d.lastSeen,
    age_minutes: Math.round(ageMs / 60_000),
    freshness: computeFreshness(d.lastSeen),
  };
}

export function registerTrackedDeviceTools(
  server: McpServer,
  trackedDeviceRepo: TrackedDeviceRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_tracked_devices',
    "Lists the latest known location of the user's devices and Bluetooth trackers from the Google Find Hub network (phones, tablets, watches, tags on keys/bag/car, etc.). These are physical THINGS, distinct from the user's own GPS location. Each result includes a resolved place, freshness, and battery when available.",
    {
      limit: z.number().min(1).max(100).optional().describe('Max devices to return. Default: 50'),
    },
    async (params) => {
      const userId = getUserId();
      const devices = await trackedDeviceRepo.listAll(userId, params.limit);
      const results = devices.map(presentDevice);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ devices: results, total: results.length }) },
        ],
      };
    },
  );

  server.tool(
    'where_is_device',
    'Locate a single tracked device or Bluetooth tag by name (fuzzy match) using the Google Find Hub network — e.g. "keys", "car", "wallet", "iPad". Returns its resolved place, coordinates, freshness, and battery. Note: Find Hub fixes are crowd-sourced and can be stale if no nearby Android device has seen the tag recently — check `freshness`/`age_minutes`.',
    {
      name: z.string().min(1).describe('Device or tracker name to locate (fuzzy match).'),
    },
    async (params) => {
      const userId = getUserId();
      const device = await trackedDeviceRepo.getByName(userId, params.name);
      if (!device) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ found: false, query: params.name }) },
          ],
        };
      }
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ found: true, device: presentDevice(device) }) },
        ],
      };
    },
  );
}
