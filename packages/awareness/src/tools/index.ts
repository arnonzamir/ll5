import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import type { EntityStatusRepository } from '../repositories/interfaces/entity-status.repository.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import { registerLocationTools } from './location.js';
import { registerMessageTools } from './messages.js';
import { registerEntityStatusTools } from './entity-statuses.js';
import { registerNotableEventTools } from './notable-events.js';
import { registerSituationTools } from './situation.js';
import { registerNotificationRuleTools } from './notification-rules.js';

export interface Repositories {
  location: LocationRepository;
  message: MessageRepository;
  entityStatus: EntityStatusRepository;
  calendar: CalendarEventRepository;
  notableEvent: NotableEventRepository;
}

export function registerAllTools(
  server: McpServer,
  repos: Repositories,
  getUserId: () => string,
  timezone: string,
  gatewayUrl?: string,
  authSecret?: string,
): void {
  registerLocationTools(server, repos.location, getUserId);
  registerMessageTools(server, repos.message, getUserId);
  registerEntityStatusTools(server, repos.entityStatus, getUserId);
  // Calendar tools retired — unified calendar reads/writes go through the calendar MCP
  registerNotableEventTools(server, repos.notableEvent, getUserId);
  registerSituationTools(
    server,
    {
      location: repos.location,
      calendar: repos.calendar,
      notableEvent: repos.notableEvent,
      message: repos.message,
    },
    getUserId,
    timezone,
  );
  if (gatewayUrl && authSecret) {
    registerNotificationRuleTools(server, getUserId, gatewayUrl, authSecret);
  }
}
