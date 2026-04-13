import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhoneStatusRepository } from '../repositories/interfaces/phone-status.repository.js';

function ageMinutes(timestamp: string): number {
  return Math.round((Date.now() - new Date(timestamp).getTime()) / 60_000);
}

export function registerPhoneStatusTools(
  server: McpServer,
  phoneStatusRepo: PhoneStatusRepository,
  getUserId: () => string,
): void {
  server.tool(
    'get_phone_status',
    "Returns the most recent phone status snapshot from the user's Android device: battery percent, charging state, plug type, temperature, low-power mode, storage, and RAM. Includes age_minutes so you can judge freshness.",
    {},
    async () => {
      const userId = getUserId();
      const latest = await phoneStatusRepo.getLatest(userId);

      if (!latest) {
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ error: 'No phone status data available' }) },
          ],
          isError: true,
        };
      }

      const result = {
        id: latest.id,
        battery_pct: latest.batteryPct,
        is_charging: latest.isCharging,
        plug_type: latest.plugType ?? null,
        battery_temp_c: latest.batteryTempC ?? null,
        battery_health: latest.batteryHealth ?? null,
        low_power_mode: latest.lowPowerMode ?? null,
        storage_used_bytes: latest.storageUsedBytes ?? null,
        storage_total_bytes: latest.storageTotalBytes ?? null,
        ram_used_bytes: latest.ramUsedBytes ?? null,
        ram_total_bytes: latest.ramTotalBytes ?? null,
        trigger: latest.trigger ?? null,
        timestamp: latest.timestamp,
        age_minutes: ageMinutes(latest.timestamp),
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ phone_status: result }) }],
      };
    },
  );

  server.tool(
    'get_phone_status_history',
    'Query phone status history over a time range. Returns snapshots sorted by timestamp descending. Use to see battery trends, when the phone was charging, low-power events, etc.',
    {
      from: z.string().describe('Start of time range (ISO 8601)'),
      to: z.string().describe('End of time range (ISO 8601)'),
      limit: z.number().min(1).max(500).optional().describe('Max results. Default: 100'),
    },
    async (params) => {
      const userId = getUserId();
      const items = await phoneStatusRepo.query(userId, {
        startTime: params.from,
        endTime: params.to,
        limit: params.limit ?? 100,
      });

      const results = items.map((s) => ({
        id: s.id,
        battery_pct: s.batteryPct,
        is_charging: s.isCharging,
        plug_type: s.plugType ?? null,
        battery_temp_c: s.batteryTempC ?? null,
        low_power_mode: s.lowPowerMode ?? null,
        trigger: s.trigger ?? null,
        timestamp: s.timestamp,
      }));

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ phone_statuses: results, total: results.length }) },
        ],
      };
    },
  );
}
