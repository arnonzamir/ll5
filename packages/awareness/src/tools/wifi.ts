import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';

function ageMinutes(timestamp: string): number {
  return Math.round((Date.now() - new Date(timestamp).getTime()) / 60_000);
}

export function registerWifiTools(
  server: McpServer,
  wifiRepo: WifiRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_current_wifi',
    "Returns the most recent WiFi connection event from the user's phone (connect, disconnect, or heartbeat). Includes SSID, BSSID, signal strength, frequency, link speed, IP, and age. Use this for location inference: when GPS is stale, the BSSID can be looked up via personal-knowledge `find_place_by_bssid` to identify where the user is.",
    {},
    async () => {
      const userId = getUserId();
      const latest = await wifiRepo.getLatest(userId);

      if (!latest) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No wifi data available' }) }],
          isError: true,
        };
      }

      const result = {
        id: latest.id,
        connected: latest.connected,
        ssid: latest.ssid,
        bssid: latest.bssid,
        rssi_dbm: latest.rssiDbm ?? null,
        frequency_mhz: latest.frequencyMhz ?? null,
        link_speed_mbps: latest.linkSpeedMbps ?? null,
        ip_address: latest.ipAddress ?? null,
        trigger: latest.trigger ?? null,
        timestamp: latest.timestamp,
        age_minutes: ageMinutes(latest.timestamp),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ wifi: result }) }],
      };
    },
  );

  server.tool(
    'get_wifi_history',
    "Query WiFi connection history over a time range, optionally filtered by SSID or BSSID. Useful for reconstructing where the user was when GPS was missing — each connect event is a strong location signal if the BSSID is known.",
    {
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      ssid: z.string().optional().describe('Filter by exact SSID'),
      bssid: z.string().optional().describe('Filter by exact BSSID (mac address)'),
      limit: z.number().min(1).max(500).optional().describe('Max results. Default: 100'),
    },
    async (params) => {
      const userId = getUserId();
      const items = await wifiRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        ssid: params.ssid,
        bssid: params.bssid,
        limit: params.limit ?? 100,
      });

      const results = items.map((w) => ({
        id: w.id,
        connected: w.connected,
        ssid: w.ssid,
        bssid: w.bssid,
        rssi_dbm: w.rssiDbm ?? null,
        trigger: w.trigger ?? null,
        timestamp: w.timestamp,
      }));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ wifi_events: results, total: results.length }) },
        ],
      };
    },
  );
}
