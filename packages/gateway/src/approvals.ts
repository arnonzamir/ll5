import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { logger } from './utils/logger.js';

/**
 * Human-approval gate for conversation AUTHORITY (contact_settings.permission).
 *
 * The LL5 agent cannot change a conversation's permission. The messaging MCP only
 * FILES a request (permission_change_requests, status='pending'). These endpoints
 * are PHONE/dashboard-authed (Bearer ll5 token → caller's user_id) and are the
 * ONLY path that applies a deferred permission change to contact_settings.
 */

export interface PendingApprovalRow {
  id: string;
  platform: string | null;
  conversation_id: string | null;
  display_name: string | null;
  current_permission: string | null;
  requested_permission: string;
  created_at: string;
}

/**
 * The caller's pending, non-expired authority requests — shared by
 * GET /approvals/pending and the Needs You tray (GET /me/tray), so both
 * surfaces always agree on what counts as "pending".
 */
export async function listPendingApprovals(pool: Pool, userId: string): Promise<PendingApprovalRow[]> {
  const result = await pool.query<PendingApprovalRow>(
    `SELECT id, platform, conversation_id, display_name, current_permission, requested_permission, created_at
     FROM permission_change_requests
     WHERE user_id = $1 AND status = 'pending' AND expires_at > now()
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows;
}

export function createApprovalsRouter(pool: Pool, authSecret: string): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);

  // GET /approvals/pending — the caller's pending, non-expired authority requests.
  router.get('/approvals/pending', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      res.json({ pending: await listPendingApprovals(pool, userId) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[approvals][pending] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /approvals/:id/decide — approve or reject a pending authority request.
  //
  // Scoped to the caller's user_id AND the row's user_id: a row that doesn't
  // belong to the caller returns 404 (no existence disclosure).
  //
  // On approve: this is the ONLY code that writes contact_settings.permission
  // from a deferred request (same ON CONFLICT (user_id,target_type,target_id)
  // upsert shape the messaging tool used before the gate).
  router.post('/approvals/:id/decide', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const id = req.params.id;
    const { decision } = (req.body ?? {}) as { decision?: string };

    if (decision !== 'approve' && decision !== 'reject') {
      res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Lock the row, scoped to the caller. Missing/foreign row → 404.
      const reqRes = await client.query<{
        id: string;
        platform: string | null;
        conversation_id: string | null;
        target_type: string;
        target_id: string;
        display_name: string | null;
        current_permission: string | null;
        requested_permission: string;
        status: string;
        expired: boolean;
      }>(
        `SELECT id, platform, conversation_id, target_type, target_id, display_name,
                current_permission, requested_permission, status,
                (expires_at <= now()) AS expired
         FROM permission_change_requests
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [id, userId],
      );
      const reqRow = reqRes.rows[0];
      if (!reqRow) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Request not found' });
        return;
      }

      if (reqRow.status !== 'pending') {
        await client.query('ROLLBACK');
        res.status(409).json({ error: `Request is already ${reqRow.status}`, status: reqRow.status });
        return;
      }
      if (reqRow.expired) {
        await client.query(
          `UPDATE permission_change_requests SET status = 'expired' WHERE id = $1`,
          [reqRow.id],
        );
        await client.query('COMMIT');
        res.status(409).json({ error: 'Request has expired', status: 'expired' });
        return;
      }

      if (decision === 'reject') {
        await client.query(
          `UPDATE permission_change_requests SET status = 'rejected', decided_at = now() WHERE id = $1`,
          [reqRow.id],
        );
        await client.query('COMMIT');

        logAudit({
          user_id: userId,
          source: 'gateway',
          action: 'permission_change_rejected',
          entity_type: 'contact_settings',
          entity_id: `${reqRow.target_type}:${reqRow.target_id}`,
          summary: `Rejected authority change for ${reqRow.target_type} ${reqRow.display_name ?? reqRow.target_id}: → ${reqRow.requested_permission}`,
          metadata: { request_id: reqRow.id, requested_permission: reqRow.requested_permission, current_permission: reqRow.current_permission, target_type: reqRow.target_type, target_id: reqRow.target_id },
        });

        res.json({ status: 'rejected', request_id: reqRow.id });
        return;
      }

      // approve → apply contact_settings.permission (the ONLY apply path).
      const upsert = await client.query<{ target_type: string; target_id: string; display_name: string | null; permission: string }>(
        `INSERT INTO contact_settings (user_id, target_type, target_id, permission, platform, display_name)
         VALUES ($1::uuid, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, target_type, target_id)
         DO UPDATE SET permission = EXCLUDED.permission,
                       platform = COALESCE(EXCLUDED.platform, contact_settings.platform),
                       display_name = COALESCE(EXCLUDED.display_name, contact_settings.display_name),
                       updated_at = now()
         RETURNING target_type, target_id, display_name, permission`,
        [userId, reqRow.target_type, reqRow.target_id, reqRow.requested_permission, reqRow.platform, reqRow.display_name],
      );
      await client.query(
        `UPDATE permission_change_requests SET status = 'applied', decided_at = now() WHERE id = $1`,
        [reqRow.id],
      );
      await client.query('COMMIT');

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'permission_change_approved',
        entity_type: 'contact_settings',
        entity_id: `${reqRow.target_type}:${reqRow.target_id}`,
        summary: `Approved authority change for ${reqRow.target_type} ${reqRow.display_name ?? reqRow.target_id}: ${reqRow.current_permission ?? 'default'} → ${reqRow.requested_permission}`,
        metadata: { request_id: reqRow.id, requested_permission: reqRow.requested_permission, current_permission: reqRow.current_permission, target_type: reqRow.target_type, target_id: reqRow.target_id },
      });

      res.json({ status: 'applied', request_id: reqRow.id, applied: upsert.rows[0] });
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* already rolled back */ }
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[approvals][decide] Failed', { userId, id, error: message });
      res.status(500).json({ error: 'Internal server error' });
    } finally {
      client.release();
    }
  });

  return router;
}
