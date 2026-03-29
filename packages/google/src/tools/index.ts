import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository } from '../repositories/interfaces/calendar-config.repository.js';
import type { UserSettingsRepository } from '../repositories/interfaces/user-settings.repository.js';
import type { ESCalendarEventRepository } from '../repositories/elasticsearch/calendar-event.repository.js';
import type { GoogleClientConfig } from '../utils/google-client.js';
import { registerAuthTools } from './auth.js';
import { registerCalendarTools } from './calendar.js';
import { registerGmailTools } from './gmail.js';
import { registerTicklerTools } from './tickler.js';

export interface ToolDependencies {
  tokenRepo: OAuthTokenRepository;
  calendarConfigRepo: CalendarConfigRepository;
  userSettingsRepo: UserSettingsRepository;
  esCalendarRepo: ESCalendarEventRepository | null;
  googleConfig: GoogleClientConfig;
}

export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
  getUserId: () => string,
): void {
  registerAuthTools(server, deps.tokenRepo, deps.calendarConfigRepo, deps.googleConfig, getUserId);
  registerCalendarTools(server, deps.tokenRepo, deps.calendarConfigRepo, deps.userSettingsRepo, deps.esCalendarRepo, deps.googleConfig, getUserId);
  registerGmailTools(server, deps.tokenRepo, deps.googleConfig, getUserId);
  registerTicklerTools(server, deps.tokenRepo, deps.calendarConfigRepo, deps.esCalendarRepo, deps.googleConfig, getUserId);
}
