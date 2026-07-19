import type { Pool } from 'pg';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { logger } from '../utils/logger.js';

interface PermissionRequestExpiryConfig {
  /** How often to scan. Cheap indexed query; 10 min default. */
  intervalMinutes: number;
  userId: string;
}

/**
 * Expiry sweep for agent-filed conversation-AUTHORITY requests
 * (permission_change_requests, migration 034).
 *
 * Without this, a request that nobody answered stayed status='pending' forever
 * while BOTH surfaces that render it (GET /approvals/pending and the Needs You
 * tray) filter on `expires_at > now()`. The row therefore vanished from the UI
 * at the deadline but was never resolved: the user could not decide it (it was
 * not shown) and the agent was never told it had lapsed. Four requests rotted
 * that way over the 2026-07-17 weekend.
 *
 * Same contract as TrayItemExpiry: this sweep is deliberately dumb. It flips
 * lapsed rows to 'expired' and tells the agent. The default is DENY — an
 * unanswered authority request changes nothing, so contact_settings.permission
 * is left exactly as it was. That is the fail-safe direction: authority is only
 * ever granted by an explicit human decision through POST /approvals/:id/decide.
 */
export class PermissionRequestExpiry {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: PermissionRequestExpiryConfig,
  ) {}

  start(): void {
    logger.info('[PermissionRequestExpiry][start] Started', {
      intervalMinutes: this.config.intervalMinutes,
      userId: this.config.userId,
    });
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60_000);
    // Run once on start so a restart during a deadline still clears the backlog.
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    let expired: Array<{
      id: string;
      display_name: string | null;
      target_type: string;
      target_id: string;
      current_permission: string | null;
      requested_permission: string;
    }>;
    try {
      const res = await this.pool.query(
        `UPDATE permission_change_requests
         SET status = 'expired', decided_at = now()
         WHERE user_id = $1 AND status = 'pending' AND expires_at < now()
         RETURNING id, display_name, target_type, target_id,
                   current_permission, requested_permission`,
        [this.config.userId],
      );
      expired = res.rows;
    } catch (err) {
      // 42P01 = table missing (pre-migration deploy) — quiet skip, like the tray.
      if ((err as { code?: string } | null)?.code === '42P01') return;
      logger.error('[PermissionRequestExpiry][tick] Failed', {
        userId: this.config.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (expired.length === 0) return;

    logger.info('[PermissionRequestExpiry][tick] Expired authority requests', {
      userId: this.config.userId,
      count: expired.length,
      ids: expired.map((r) => r.id),
    });

    for (const row of expired) {
      const who = row.display_name ?? `${row.target_type} ${row.target_id}`;
      const stays = row.current_permission ?? 'default';
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        `[Authority] request expired unanswered for ${who}: ` +
          `${stays} → ${row.requested_permission} was NOT applied. ` +
          `Authority stays '${stays}' (deny is the default when nobody answers). ` +
          `File a fresh request if you still need the change.`,
        undefined,
        createSchedulerEvent('permission_request_expiry'),
      );
    }
  }
}
