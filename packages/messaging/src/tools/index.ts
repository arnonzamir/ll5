import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccountRepository } from '../repositories/interfaces/account.repository.js';
import type { ConversationRepository } from '../repositories/interfaces/conversation.repository.js';
import type { ContactRepository } from '../repositories/interfaces/contact.repository.js';
import { registerListAccountsTool } from './list-accounts.js';
import { registerSendWhatsAppTool } from './send-whatsapp.js';
import { registerSendTelegramTool } from './send-telegram.js';
import { registerListConversationsTool } from './list-conversations.js';
import { registerUpdatePermissionsTool } from './update-permissions.js';
import { registerReadMessagesTool } from './read-messages.js';
import { registerSyncWhatsAppTool } from './sync-whatsapp.js';
import { registerGetAccountStatusTool } from './get-account-status.js';
import { registerCreateWhatsAppAccountTool } from './create-whatsapp-account.js';
import { registerListContactsTool } from './list-contacts.js';
import { registerResolveContactTool } from './resolve-contact.js';
import { registerLinkContactTool, registerUnlinkContactTool } from './link-contact.js';
import { registerAutoMatchContactsTool } from './auto-match-contacts.js';

export interface ToolDependencies {
  accountRepo: AccountRepository;
  conversationRepo: ConversationRepository;
  contactRepo: ContactRepository;
  encryptionKey: string;
}

export function registerAllTools(
  server: McpServer,
  deps: ToolDependencies,
  getUserId: () => string,
): void {
  registerListAccountsTool(server, deps.accountRepo, getUserId);
  registerSendWhatsAppTool(server, deps.accountRepo, deps.conversationRepo, getUserId);
  registerSendTelegramTool(server, deps.accountRepo, deps.conversationRepo, getUserId);
  registerListConversationsTool(server, deps.conversationRepo, getUserId);
  registerUpdatePermissionsTool(server, deps.conversationRepo, getUserId);
  registerReadMessagesTool(server, deps.accountRepo, deps.conversationRepo, getUserId);
  registerSyncWhatsAppTool(server, deps.accountRepo, deps.conversationRepo, deps.contactRepo, getUserId);
  registerGetAccountStatusTool(server, deps.accountRepo, getUserId);
  registerCreateWhatsAppAccountTool(server, deps.accountRepo, deps.encryptionKey, getUserId);
  registerListContactsTool(server, deps.contactRepo, getUserId);
  registerResolveContactTool(server, deps.contactRepo, getUserId);
  registerLinkContactTool(server, deps.contactRepo, getUserId);
  registerUnlinkContactTool(server, deps.contactRepo, getUserId);
  registerAutoMatchContactsTool(server, deps.contactRepo, getUserId);
}
