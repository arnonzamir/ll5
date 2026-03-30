import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import { logger } from './logger.js';

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

/**
 * Expand short scope names to full Google scope URLs.
 * e.g., "calendar.readonly" -> "https://www.googleapis.com/auth/calendar.readonly"
 */
export function expandScopes(scopes?: string[]): string[] {
  if (!scopes || scopes.length === 0) return DEFAULT_SCOPES;
  return scopes.map((s) => (s.startsWith('https://') ? s : `${SCOPE_PREFIX}${s}`));
}

/**
 * Create a bare OAuth2Client (not authenticated).
 */
export function createOAuth2Client(config: GoogleClientConfig): OAuth2Client {
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

/**
 * Get an authenticated OAuth2Client for a given user.
 * Automatically refreshes the access token if expired.
 */
export async function getAuthenticatedClient(
  config: GoogleClientConfig,
  tokenRepo: OAuthTokenRepository,
  userId: string,
): Promise<OAuth2Client> {
  const tokens = await tokenRepo.get(userId);
  if (!tokens) {
    throw new Error('Google account not connected. Use get_auth_url to start OAuth flow.');
  }

  const oauth2Client = createOAuth2Client(config);
  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expiry_date: tokens.expires_at.getTime(),
  });

  // Check if token is expired or will expire in the next 60 seconds
  const now = Date.now();
  const expiresAt = tokens.expires_at.getTime();
  if (expiresAt - now < 60_000) {
    logger.info('[getAuthenticatedClient] Access token expired or expiring soon, refreshing', { userId });
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      const newAccessToken = credentials.access_token;
      const newExpiryDate = credentials.expiry_date;

      if (newAccessToken && newExpiryDate) {
        await tokenRepo.updateAccessToken(userId, newAccessToken, new Date(newExpiryDate));
        oauth2Client.setCredentials(credentials);
        logger.info('[getAuthenticatedClient] Access token refreshed successfully', { userId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[getAuthenticatedClient] Failed to refresh access token', { userId, error: message });
      throw new Error(`Failed to refresh Google access token: ${message}`);
    }
  }

  return oauth2Client;
}
