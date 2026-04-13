#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  getBattery,
  getCpu,
  getMemory,
  getDisk,
  getSystem,
  getSystemHealth,
  formatBytes,
} from './collectors.js';

function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

async function main() {
  const server = new McpServer({
    name: 'll5-system',
    version: '0.1.0',
  });

  server.tool(
    'get_battery',
    'Get battery status of this Mac: percent charge, charging state, power source, and time remaining. Returns available=false on machines without a battery.',
    {},
    async () => jsonResult(await getBattery()),
  );

  server.tool(
    'get_cpu',
    'Get CPU info for this Mac: model, core count, 1/5/15-minute load averages, load per core, and total CPU usage percent.',
    {},
    async () => jsonResult(await getCpu()),
  );

  server.tool(
    'get_memory',
    'Get RAM stats for this Mac. "usedBytes" matches Activity Monitor "Memory Used" = app + wired + compressed (does NOT count cached files, which are reclaimable). "pressure" is the kernel signal (kern.memorystatus_vm_pressure_level) — same source Activity Monitor uses for green/yellow/red. ALWAYS trust pressure over usedPercent.',
    {},
    async () => {
      const m = await getMemory();
      return jsonResult({
        ...m,
        totalHuman: formatBytes(m.totalBytes),
        usedHuman: formatBytes(m.usedBytes),
        availableHuman: formatBytes(m.availableBytes),
        appHuman: m.appBytes != null ? formatBytes(m.appBytes) : null,
        wiredHuman: m.wiredBytes != null ? formatBytes(m.wiredBytes) : null,
        compressedHuman: m.compressedBytes != null ? formatBytes(m.compressedBytes) : null,
        cachedFilesHuman: m.cachedFilesBytes != null ? formatBytes(m.cachedFilesBytes) : null,
        swapUsedHuman: m.swapUsedBytes != null ? formatBytes(m.swapUsedBytes) : null,
      });
    },
  );

  server.tool(
    'get_disk',
    'Get disk usage for a mount point on this Mac. Defaults to the root volume "/".',
    {
      mount: z.string().optional().describe('Mount point to inspect (default "/")'),
    },
    async ({ mount }) => {
      const d = await getDisk(mount ?? '/');
      return jsonResult({
        ...d,
        totalHuman: formatBytes(d.totalBytes),
        usedHuman: formatBytes(d.usedBytes),
        freeHuman: formatBytes(d.freeBytes),
      });
    },
  );

  server.tool(
    'get_system_info',
    'Get basic system info for this Mac: hostname, platform, OS release, and uptime in seconds.',
    {},
    async () => jsonResult(getSystem()),
  );

  server.tool(
    'get_system_health',
    'Single combined check: returns battery + cpu + memory + disk + system info, plus a status (ok/warning/critical) and a list of warnings if any threshold is crossed. Use this when you want a quick "is anything wrong with my computer?" answer.',
    {},
    async () => jsonResult(await getSystemHealth()),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // stderr only — stdout is reserved for the MCP transport
  console.error('[ll5-system] Fatal:', err);
  process.exit(1);
});
