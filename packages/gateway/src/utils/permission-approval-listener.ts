import pg from 'pg';
import type { Pool } from 'pg';
import { logger } from './logger.js';
import { sendFCMNotification } from './fcm-sender.js';

/**
 * Durable Postgres LISTEN on 'permission_approval'.
 *
 * The messaging MCP files a pending authority (permission) change and emits
 * `pg_notify('permission_approval', <user_id>)`. This listener fans that into an
 * FCM push so the user's phone prompts for fingerprint approval. The change is
 * applied only when the user calls POST /approvals/:id/decide (see approvals.ts).
 *
 * Mirrors the /chat/listen PG-listener pattern (dedicated pg.Client, single
 * idempotent teardown, auto-reconnect on error). Returns a stop() for tests.
 */
export function startPermissionApprovalListener(pool: Pool): { stop: () => void } {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn('[permission-approval][listen] No DATABASE_URL — listener not started');
    return { stop: () => {} };
  }

  let stopped = false;
  let listener: pg.Client | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const client = new pg.Client({ connectionString });
    listener = client;

    client.on('notification', (msg) => {
      const userId = (msg.payload ?? '').trim();
      if (!userId) return;
      sendFCMNotification(pool, userId, {
        title: 'LL5 wants to change a conversation’s authority',
        body: 'Approve on the app to apply the permission change.',
        type: 'permission_approval',
        priority: 'high',
        notification_level: 'alert',
        data: { type: 'permission_approval' },
      }).catch((err) => {
        logger.warn('[permission-approval][notify] FCM send failed', { error: err instanceof Error ? err.message : String(err) });
      });
    });

    client.on('error', (err: unknown) => {
      logger.warn('[permission-approval][listen] PG listener error — reconnecting', { error: err instanceof Error ? err.message : String(err) });
      scheduleReconnect();
    });

    try {
      await client.connect();
      await client.query('LISTEN permission_approval');
      logger.info('[permission-approval][listen] Listening for authority-change approvals');
    } catch (err) {
      logger.warn('[permission-approval][listen] Connect failed — retrying', { error: err instanceof Error ? err.message : String(err) });
      scheduleReconnect();
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    if (listener) {
      listener.end().catch(() => {});
      listener = null;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 5_000);
  };

  void connect();

  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (listener) {
        listener.end().catch(() => {});
        listener = null;
      }
    },
  };
}
