import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { NetworkRepository } from '../repositories/interfaces/network.repository.js';
import type { PlaceRepository } from '../repositories/interfaces/place.repository.js';
import { logAudit } from '@ll5/shared';

export function registerNetworkTools(
  server: McpServer,
  networkRepo: NetworkRepository,
  placeRepo: PlaceRepository,
  getUserId: () => string,
): void {
  server.tool(
    'find_place_by_bssid',
    "Look up a WiFi BSSID and return the place it's bound to. Returns the place plus a source ('manual' if the user explicitly labeled it, 'auto' if learned from GPS co-occurrence) and a confidence score (0-1). Returns null if the BSSID is unknown or has too few observations to be confident. Use this when GPS is stale to infer the user's location from their current WiFi.",
    {
      bssid: z.string().describe('The BSSID (MAC address) of the WiFi access point, e.g. "aa:bb:cc:dd:ee:ff"'),
    },
    async (params) => {
      const userId = getUserId();
      const resolved = await networkRepo.resolvePlaceByBssid(userId, params.bssid);

      if (!resolved) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                bssid: params.bssid,
                place: null,
                reason: 'unknown_or_low_confidence',
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              bssid: params.bssid,
              place: {
                place_id: resolved.placeId,
                place_name: resolved.placeName,
              },
              source: resolved.source,
              confidence: Math.round(resolved.confidence * 100) / 100,
              observation_count: resolved.observationCount,
              total_observations: resolved.totalObservations,
              last_seen: resolved.lastSeen,
              ssid: resolved.ssid ?? null,
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'label_network',
    "Manually bind a WiFi BSSID to a known place. The place must already exist in personal-knowledge places (use list_places or upsert_place first). Manual labels override any auto-learned binding.",
    {
      bssid: z.string().describe('The BSSID (MAC address) of the WiFi access point'),
      place_id: z.string().describe('The ID of the place from ll5_knowledge_places'),
      label: z.string().optional().describe('Optional human label for this network, e.g. "main router", "office mesh AP 2"'),
    },
    async (params) => {
      const userId = getUserId();

      // Validate the place exists and belongs to this user
      const place = await placeRepo.get(userId, params.place_id);
      if (!place) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: `Place not found: ${params.place_id}` }),
            },
          ],
          isError: true,
        };
      }

      const network = await networkRepo.setManualPlace(
        userId,
        params.bssid,
        params.place_id,
        place.name,
        params.label,
      );

      logAudit({
        user_id: userId,
        source: 'personal-knowledge',
        action: 'create',
        entity_type: 'known_network',
        entity_id: params.bssid,
        summary: `Bound BSSID ${params.bssid} to place "${place.name}"`,
        metadata: { bssid: params.bssid, place_id: params.place_id, label: params.label },
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              bssid: network.bssid,
              ssid: network.ssid ?? null,
              place_id: params.place_id,
              place_name: place.name,
              label: params.label ?? null,
              source: 'manual',
            }),
          },
        ],
      };
    },
  );

  server.tool(
    'unlabel_network',
    "Remove the manual place binding from a BSSID. Auto-learned observations remain — `find_place_by_bssid` will fall back to the dominant auto-learned place if any.",
    {
      bssid: z.string().describe('The BSSID (MAC address) of the WiFi access point'),
    },
    async (params) => {
      const userId = getUserId();
      const cleared = await networkRepo.clearManualPlace(userId, params.bssid);
      if (!cleared) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'No manual label found for this BSSID' }),
            },
          ],
          isError: true,
        };
      }

      logAudit({
        user_id: userId,
        source: 'personal-knowledge',
        action: 'delete',
        entity_type: 'known_network',
        entity_id: params.bssid,
        summary: `Cleared manual label for BSSID ${params.bssid}`,
      });

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ bssid: params.bssid, cleared: true }) },
        ],
      };
    },
  );

  server.tool(
    'list_known_networks',
    "List all WiFi networks the system has observed for this user, sorted by most recently seen. Includes per-place observation counts so you can see what the auto-learning has captured.",
    {
      limit: z.number().min(1).max(500).optional().describe('Max results. Default: 100'),
    },
    async (params) => {
      const userId = getUserId();
      const networks = await networkRepo.list(userId, params.limit ?? 100);

      const results = networks.map((n) => ({
        bssid: n.bssid,
        ssid: n.ssid ?? null,
        label: n.label ?? null,
        manual_place_id: n.manualPlaceId ?? null,
        manual_place_name: n.manualPlaceName ?? null,
        place_observations: n.placeObservations.map((o) => ({
          place_id: o.placeId,
          place_name: o.placeName,
          count: o.count,
          last_seen: o.lastSeen,
        })),
        total_observations: n.totalObservations,
        first_seen: n.firstSeen,
        last_seen: n.lastSeen,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ networks: results, total: results.length }),
          },
        ],
      };
    },
  );
}
