import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HorizonRepository } from '../repositories/interfaces/horizon.repository.js';
import type { InboxRepository } from '../repositories/interfaces/inbox.repository.js';
import { registerActionTools } from './actions.js';
import { registerProjectTools } from './projects.js';
import { registerHorizonTools } from './horizons.js';
import { registerInboxTools } from './inbox.js';
import { registerShoppingTools } from './shopping.js';
import { registerRecommendationTools } from './recommendations.js';
import { registerHealthTools } from './health.js';

export interface ToolDependencies {
  horizonRepo: HorizonRepository;
  inboxRepo: InboxRepository;
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
  registerShoppingTools(server, deps.horizonRepo, getUserId);
  registerRecommendationTools(server, deps.horizonRepo, getUserId);
  registerHealthTools(server, deps.horizonRepo, getUserId);
}
