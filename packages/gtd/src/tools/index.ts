import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import type { Client as EsClient } from '@elastic/elasticsearch';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';
import type { InboxRepository } from '../repositories/interfaces/inbox.repository.js';
import type { HabitRepository } from '../repositories/interfaces/habit.repository.js';
import { registerActionTools } from './actions.js';
import { registerHabitTools } from './habits.js';
import { registerProjectTools } from './projects.js';
import { registerHorizonTools } from './horizons.js';
import { registerInboxTools } from './inbox.js';
import { registerShoppingTools } from './shopping.js';
import { registerRecommendationTools } from './recommendations.js';
import { registerHealthTools } from './health.js';
import { registerChatTools } from './chat.js';
import { registerReconcileTools } from './reconcile.js';

export interface ToolDependencies {
  horizonRepo: HorizonRepository;
  inboxRepo: InboxRepository;
  habitRepo: HabitRepository;
  gatewayUrl: string;
  authSecret: string;
  /** PostgreSQL pool — the reconcile gate runs its own transactions. */
  pool: Pool;
  /** Read-only awareness ES client (only `.search` is ever called). Null when
   *  ELASTICSEARCH_URL is unset — the selector then degrades to empty. */
  esClient: EsClient | null;
}

export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
  getUserId: () => string,
): void {
  registerActionTools(server, deps.horizonRepo, getUserId);
  registerProjectTools(server, deps.horizonRepo, getUserId);
  registerHorizonTools(server, deps.horizonRepo, getUserId);
  registerInboxTools(server, deps.inboxRepo, getUserId);
  registerHabitTools(server, deps.habitRepo, getUserId);
  registerShoppingTools(server, deps.horizonRepo, getUserId);
  registerRecommendationTools(server, deps.horizonRepo, getUserId);
  registerHealthTools(server, deps.horizonRepo, getUserId);
  registerChatTools(server, { gatewayUrl: deps.gatewayUrl, authSecret: deps.authSecret }, getUserId);
  registerReconcileTools(server, deps.pool, deps.esClient, getUserId);
}
