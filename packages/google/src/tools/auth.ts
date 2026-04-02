import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import type { CalendarConfigRepository } from '../repositories/interfaces/calendar-config.repository.js';
import {
  createOAuth2Client,
  expandScopes,
  type GoogleClientConfig,
} from '../utils/google-client.js';
import { logger } from '../utils/logger.js';

// In-memory CSRF state store (keyed by state token -> userId)
// In production with multiple instances, use Redis or DB.
export const pendingStates = new Map<string, { userId: string; scopes: string[] }>();

export function registerAuthTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  calendarConfigRepo: CalendarConfigRepository,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // get_auth_url
  // ---------------------------------------------------------------------------
  server.tool(
    'get_auth_url',
    'Generate a Google OAuth2 authorization URL for the user to visit and grant access.',
    {
      scopes: z.array(z.string()).optional().describe(
        'Requested scopes. Defaults to calendar.readonly, calendar.events, gmail.readonly, gmail.send',
      ),
    },
    async ({ scopes }) => {
      const userId = getUserId();
      const expandedScopes = expandScopes(scopes);
      const state = randomBytes(32).toString('hex');

      pendingStates.set(state, { userId, scopes: expandedScopes });

      // Clean up old states after 10 minutes
      setTimeout(() => {
        pendingStates.delete(state);
      }, 10 * 60 * 1000);

      const oauth2Client = createOAuth2Client(config);
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: expandedScopes,
        state,
        prompt: 'consent',
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            auth_url: authUrl,
            state,
            requested_scopes: expandedScopes,
          }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // handle_oauth_callback
  // ---------------------------------------------------------------------------
  server.tool(
    'handle_oauth_callback',
    'Process OAuth2 callback code after user authorizes. Exchanges the code for tokens and stores them.',
    {
      code: z.string().describe('Authorization code from OAuth callback'),
      state: z.string().describe('CSRF state token for validation'),
    },
    async ({ code, state }) => {
      const userId = getUserId();

      // Validate CSRF state
      const pendingState = pendingStates.get(state);
      if (!pendingState || pendingState.userId !== userId) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'Invalid or expired state token' }),
          }],
        };
      }
      pendingStates.delete(state);

      try {
        const oauth2Client = createOAuth2Client(config);
        const { tokens } = await oauth2Client.getToken(code);

        if (!tokens.access_token || !tokens.refresh_token) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Missing access_token or refresh_token in response. Ensure prompt=consent is set.',
              }),
            }],
          };
        }

        const expiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600_000);
        const grantedScopes = tokens.scope ? tokens.scope.split(' ') : pendingState.scopes;

        await tokenRepo.store(userId, {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type ?? 'Bearer',
          expires_at: expiresAt,
          scopes: grantedScopes,
        });

        // Try to get user email
        let email = '';
        try {
          oauth2Client.setCredentials(tokens);
          const oauth2 = (await import('googleapis')).google.oauth2({ version: 'v2', auth: oauth2Client });
          const userInfo = await oauth2.userinfo.get();
          email = userInfo.data.email ?? '';
        } catch (err) {
          logger.warn('[auth][handleOAuthCallback] Could not fetch user email after OAuth', { error: err instanceof Error ? err.message : String(err) });
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              granted_scopes: grantedScopes,
              email,
            }, null, 2),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[auth][handleOAuthCallback] OAuth callback failed', { error: message });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: message }),
          }],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // get_connection_status
  // ---------------------------------------------------------------------------
  server.tool(
    'get_connection_status',
    'Check if Google is connected for this user, whether the token is valid, and what scopes were granted.',
    {},
    async () => {
      const userId = getUserId();
      const tokens = await tokenRepo.get(userId);

      if (!tokens) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              connected: false,
              token_valid: false,
              email: null,
              granted_scopes: [],
              expires_at: null,
              last_refreshed: null,
            }, null, 2),
          }],
        };
      }

      const now = new Date();
      const tokenValid = tokens.expires_at > now;

      // Try to get email from token info
      let email: string | null = null;
      try {
        const oauth2Client = createOAuth2Client(config);
        oauth2Client.setCredentials({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
        });
        const oauth2 = (await import('googleapis')).google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();
        email = userInfo.data.email ?? null;
      } catch (err) {
        // Token may be expired; that's ok, we still report status
        logger.debug('[auth][connectionStatus] Could not fetch user email', { error: err instanceof Error ? err.message : String(err) });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            connected: true,
            token_valid: tokenValid,
            email,
            granted_scopes: tokens.scopes,
            expires_at: tokens.expires_at.toISOString(),
            last_refreshed: tokens.updated_at.toISOString(),
          }, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // disconnect
  // ---------------------------------------------------------------------------
  server.tool(
    'disconnect',
    'Revoke Google OAuth2 access and delete stored tokens and calendar config for the user.',
    {},
    async () => {
      const userId = getUserId();
      let revoked = false;

      const tokens = await tokenRepo.get(userId);
      if (tokens) {
        try {
          const oauth2Client = createOAuth2Client(config);
          oauth2Client.setCredentials({ access_token: tokens.access_token });
          await oauth2Client.revokeToken(tokens.access_token);
          revoked = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('[auth][disconnect] Token revocation failed (may already be expired)', { error: message });
        }
      }

      await tokenRepo.delete(userId);
      await calendarConfigRepo.deleteAll(userId);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, revoked }, null, 2),
        }],
      };
    },
  );
}
