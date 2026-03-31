import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { logger } from './logger.js';

interface FCMMessage {
  title: string;
  body: string;
  type: string;
  priority: 'normal' | 'high';
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

let cachedToken: { token: string; expiresAt: number } | null = null;
let serviceAccount: ServiceAccount | null = null;

function loadServiceAccount(): ServiceAccount | null {
  if (serviceAccount) return serviceAccount;

  const json = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!json) {
    // Try file path
    const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
    if (!path) return null;
    try {
      const fs = require('node:fs');
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'));
      serviceAccount = data;
      return serviceAccount;
    } catch {
      return null;
    }
  }

  try {
    serviceAccount = JSON.parse(json);
    return serviceAccount;
  } catch {
    return null;
  }
}

/**
 * Create a JWT signed with the service account private key.
 */
function createJWT(sa: ServiceAccount): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const signInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(sa.private_key, 'base64url');

  return `${signInput}.${signature}`;
}

/**
 * Get an OAuth2 access token for FCM v1 API.
 */
async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }

  const jwt = createJWT(sa);
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cachedToken.token;
}

/**
 * Send a push notification via FCM v1 API.
 * Requires FCM_SERVICE_ACCOUNT_JSON or FCM_SERVICE_ACCOUNT_PATH env var.
 */
export async function sendFCMNotification(
  pool: Pool,
  userId: string,
  message: FCMMessage,
): Promise<void> {
  const sa = loadServiceAccount();
  if (!sa) {
    logger.debug('[sendFCMNotification] No FCM service account configured');
    return;
  }

  const result = await pool.query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0) {
    logger.debug('[sendFCMNotification] No FCM tokens for user');
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch (err) {
    logger.warn('[sendFCMNotification] Failed to get access token', {
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const url = `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`;

  for (const row of result.rows) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token: row.token,
            data: {
              type: message.type,
              title: message.title,
              body: message.body,
              priority: message.priority,
            },
            android: {
              priority: message.priority === 'high' ? 'high' : 'normal',
            },
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('[sendFCMNotification] FCM v1 send failed', { status: response.status, body: text });
      } else {
        logger.info('[sendFCMNotification] Push sent', { type: message.type, priority: message.priority });
      }
    } catch (err) {
      logger.warn('[sendFCMNotification] FCM send error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
