import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { logger } from './logger.js';

export type NotificationLevel = 'silent' | 'notify' | 'alert' | 'critical';

interface FCMMessage {
  title: string;
  body: string;
  type: string;
  /** Notification level chosen by the agent or system. */
  notification_level?: NotificationLevel;
  /** @deprecated Use notification_level instead. Maps high→alert, normal→silent. */
  priority?: 'normal' | 'high';
  data?: Record<string, string>;
}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

const LEVEL_RANK: Record<NotificationLevel, number> = {
  silent: 0,
  notify: 1,
  alert: 2,
  critical: 3,
};

let cachedToken: { token: string; expiresAt: number } | null = null;
let serviceAccount: ServiceAccount | null = null;

function loadServiceAccount(): ServiceAccount | null {
  if (serviceAccount) return serviceAccount;

  const json = process.env.FCM_SERVICE_ACCOUNT_JSON;
  if (!json) {
    const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
    if (!path) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      serviceAccount = data;
      return serviceAccount;
    } catch (err) {
      logger.warn('[FCMSender][loadServiceAccount] Failed to load service account file', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  try {
    serviceAccount = JSON.parse(json);
    return serviceAccount;
  } catch (err) {
    logger.warn('[FCMSender][loadServiceAccount] Failed to parse FCM_SERVICE_ACCOUNT_JSON', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

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
 * Resolve the effective notification level based on what was requested,
 * the user's max level setting, and whether it's currently quiet hours.
 */
async function resolveLevel(
  pool: Pool,
  userId: string,
  requested: NotificationLevel,
): Promise<NotificationLevel> {
  try {
    const result = await pool.query(
      'SELECT settings FROM user_settings WHERE user_id = $1',
      [userId],
    );

    if (result.rows.length === 0) {
      return requested;
    }

    const allSettings = result.rows[0].settings ?? {};
    const notif = allSettings.notification ?? {};
    const maxLevel = (notif.max_level as NotificationLevel) ?? 'critical';
    const tz = allSettings.timezone ?? 'Asia/Jerusalem';

    // Check if currently in quiet hours
    let effectiveMax = maxLevel;
    try {
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentTime = formatter.format(now);

      const quietStart = (notif.quiet_start as string) ?? '23:00';
      const quietEnd = (notif.quiet_end as string) ?? '07:00';

      const inQuietHours = quietStart > quietEnd
        ? currentTime >= quietStart || currentTime < quietEnd
        : currentTime >= quietStart && currentTime < quietEnd;

      if (inQuietHours) {
        effectiveMax = (notif.quiet_max_level as NotificationLevel) ?? 'silent';
      }
    } catch {
      // Timezone parsing failed — use normal max
    }

    if (LEVEL_RANK[requested] > LEVEL_RANK[effectiveMax]) {
      logger.info('[FCMSender][resolveLevel] Capping notification level', {
        requested,
        effectiveMax,
        userId,
      });
      return effectiveMax;
    }

    return requested;
  } catch (err) {
    logger.warn('[FCMSender][resolveLevel] Failed to check settings, using requested level', {
      error: err instanceof Error ? err.message : String(err),
    });
    return requested;
  }
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
    logger.debug('[FCMSender][send] No FCM service account configured');
    return;
  }

  const result = await pool.query(
    'SELECT token FROM fcm_tokens WHERE user_id = $1',
    [userId],
  );

  if (result.rows.length === 0) {
    logger.debug('[FCMSender][send] No FCM tokens for user');
    return;
  }

  // Resolve notification level
  let level: NotificationLevel;
  if (message.notification_level) {
    level = message.notification_level;
  } else if (message.priority === 'high') {
    level = 'alert';
  } else {
    level = 'silent';
  }

  level = await resolveLevel(pool, userId, level);

  // Map level to Android priority
  const androidPriority = level === 'alert' || level === 'critical' ? 'high' : 'normal';

  let accessToken: string;
  try {
    accessToken = await getAccessToken(sa);
  } catch (err) {
    logger.warn('[FCMSender][send] Failed to get access token', {
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
              notification_level: level,
              ...(message.data ?? {}),
            },
            android: {
              priority: androidPriority,
            },
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        logger.warn('[FCMSender][send] FCM v1 send failed', { status: response.status, body: text });
      } else {
        logger.info('[FCMSender][send] Push sent', { type: message.type, level });
      }
    } catch (err) {
      logger.warn('[FCMSender][send] FCM send error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
