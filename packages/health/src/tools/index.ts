import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { registerSourceTools } from './sources.js';
import { registerSleepTools } from './sleep.js';
import { registerHeartRateTools } from './heart-rate.js';
import { registerDailyStatsTools } from './daily-stats.js';
import { registerActivityTools } from './activities.js';
import { registerBodyCompositionTools } from './body-composition.js';
import { registerTrendTools } from './trends.js';
import { registerSyncTools } from './sync.js';

export function registerAllTools(
  server: McpServer,
  esClient: Client,
  pool: Pool,
  getUserId: () => string,
  encryptionKey: string,
): void {
  registerSourceTools(server, pool, getUserId, encryptionKey);
  registerSleepTools(server, esClient, getUserId);
  registerHeartRateTools(server, esClient, getUserId);
  registerDailyStatsTools(server, esClient, getUserId);
  registerActivityTools(server, esClient, getUserId);
  registerBodyCompositionTools(server, esClient, getUserId);
  registerTrendTools(server, esClient, getUserId);
  registerSyncTools(server, esClient, pool, getUserId, encryptionKey);
}
