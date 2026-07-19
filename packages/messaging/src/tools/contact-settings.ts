import { z } from 'zod';
import type { Pool } from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logAudit } from '@ll5/shared';
import { filePermissionChangeRequest } from './permission-requests.js';

/**
 * Resolve a target identifier to a contact_settings (target_type, target_id) pair.
 *
 * Accepts either a KB person_id (→ person target) or a platform + conversation_id
 * (→ resolved via messaging_contacts: a linked 1:1 becomes a person target, a group
 * or unlinked chat becomes a group target keyed by the conversation JID).
 */
async function resolveTarget(
  pool: Pool,
  userId: string,
  args: { person_id?: string; platform?: string; conversation_id?: string },
): Promise<{ targetType: 'person' | 'group'; targetId: string; displayName: string | null } | { error: string }> {
  if (args.person_id) {
    // Look the name up rather than returning null: this display_name is what
    // the authority-approval card shows the user ("May I handle <name> as
    // ..."). Returning null here produced nameless, unanswerable cards for
    // every request the agent filed by person_id. A person can have several
    // contact rows (one per platform) — take the first that actually has a
    // name, and fall back to null (the card then shows the target id).
    const named = await pool.query<{ display_name: string | null }>(
      `SELECT display_name
       FROM messaging_contacts
       WHERE user_id = $1 AND person_id = $2 AND display_name IS NOT NULL
       LIMIT 1`,
      [userId, args.person_id],
    );
    return {
      targetType: 'person',
      targetId: args.person_id,
      displayName: named.rows[0]?.display_name ?? null,
    };
  }
  if (args.platform && args.conversation_id) {
    const contact = await pool.query<{ is_group: boolean; person_id: string | null; display_name: string | null }>(
      `SELECT is_group, person_id, display_name
       FROM messaging_contacts
       WHERE user_id = $1 AND platform = $2 AND platform_id = $3
       LIMIT 1`,
      [userId, args.platform, args.conversation_id],
    );
    const row = contact.rows[0];
    if (row && row.is_group === false && row.person_id) {
      return { targetType: 'person', targetId: row.person_id, displayName: row.display_name };
    }
    return { targetType: 'group', targetId: args.conversation_id, displayName: row?.display_name ?? null };
  }
  return { error: 'Provide either person_id, or both platform and conversation_id.' };
}

export function registerContactSettingsTools(
  server: McpServer,
  pool: Pool,
  getUserId: () => string,
): void {
  // -- Read ---------------------------------------------------------------
  server.tool(
    'get_contact_settings',
    'Get communication settings (routing/Delivery, permission/Authority, image download) for a contact or chat. ' +
      'Pass person_id for a person, or platform+conversation_id for a chat. Omit all args to list every configured contact/chat. ' +
      'routing: ignore (drop) | batch (periodic summary) | immediate (notify agent) | agent (notify + agent can respond). ' +
      'permission: ignore (agent cannot read) | input (read only) | agent (read + can reply). image_download: whether incoming images/audio are fetched.',
    {
      person_id: z.string().optional().describe('KB person id, for a 1:1 contact'),
      platform: z.enum(['whatsapp', 'telegram', 'sms', 'slack', 'gmail']).optional().describe('Platform, with conversation_id'),
      conversation_id: z.string().optional().describe('Platform conversation id / JID, with platform'),
    },
    async (args) => {
      const userId = getUserId();

      // No target → list everything.
      if (!args.person_id && !args.conversation_id) {
        const all = await pool.query(
          `SELECT target_type, target_id, display_name, routing, permission, download_media, platform, updated_at
           FROM contact_settings WHERE user_id = $1 ORDER BY updated_at DESC`,
          [userId],
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ count: all.rows.length, contacts: all.rows }, null, 2) }],
        };
      }

      const resolved = await resolveTarget(pool, userId, args);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }

      const result = await pool.query(
        `SELECT target_type, target_id, display_name, routing, permission, download_media, platform, updated_at
         FROM contact_settings WHERE user_id = $1 AND target_type = $2 AND target_id = $3 LIMIT 1`,
        [userId, resolved.targetType, resolved.targetId],
      );

      if (result.rows.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              target_type: resolved.targetType,
              target_id: resolved.targetId,
              configured: false,
              // 1:1 (person) includes pictures by default; groups are opt-in.
              defaults: { routing: 'batch', permission: 'input', download_media: resolved.targetType === 'person' },
            }, null, 2),
          }],
        };
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify({ configured: true, ...result.rows[0] }, null, 2) }] };
    },
  );

  // -- Write --------------------------------------------------------------
  server.tool(
    'set_contact_settings',
    'Set communication settings for a contact or chat — change any of routing (Delivery), permission (Authority), or image download. ' +
      'Identify the target with person_id, or platform+conversation_id. Only the fields you pass are changed; others are left as-is. ' +
      'routing and download_media apply IMMEDIATELY. permission (Authority) is protected: passing it does NOT apply the change — ' +
      'it files a pending request that the user must approve with a fingerprint on the phone. ' +
      'routing: ignore | batch | immediate | agent. permission: ignore | input | agent. download_media: true/false (fetch incoming images & audio).',
    {
      person_id: z.string().optional().describe('KB person id, for a 1:1 contact'),
      platform: z.enum(['whatsapp', 'telegram', 'sms', 'slack', 'gmail']).optional().describe('Platform, with conversation_id'),
      conversation_id: z.string().optional().describe('Platform conversation id / JID, with platform'),
      routing: z.enum(['ignore', 'batch', 'immediate', 'agent']).optional().describe('Delivery: how inbound messages are surfaced'),
      permission: z.enum(['ignore', 'input', 'agent']).optional().describe('Authority: what the agent may do (read / reply)'),
      download_media: z.boolean().optional().describe('Whether incoming images/audio are downloaded for this contact'),
    },
    async (args) => {
      const userId = getUserId();

      if (args.routing === undefined && args.permission === undefined && args.download_media === undefined) {
        return { content: [{ type: 'text' as const, text: 'Provide at least one of routing, permission, or download_media to change.' }], isError: true };
      }

      const resolved = await resolveTarget(pool, userId, args);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }], isError: true };
      }

      // permission (Authority) is a protected setting — it is NEVER written here.
      // It is split out into a pending approval request (fingerprint on the phone).
      // routing + download_media still apply immediately.
      const applyRouting = args.routing !== undefined;
      const applyMedia = args.download_media !== undefined;
      const applyNow = applyRouting || applyMedia;

      let appliedRow: Record<string, unknown> | undefined;
      if (applyNow) {
        const result = await pool.query(
          `INSERT INTO contact_settings (user_id, target_type, target_id, routing, permission, download_media, platform, display_name)
           VALUES ($1, $2, $3, COALESCE($4,'batch'), 'input', COALESCE($5,false), $6, $7)
           ON CONFLICT (user_id, target_type, target_id)
           DO UPDATE SET routing = COALESCE($4, contact_settings.routing),
                         download_media = COALESCE($5, contact_settings.download_media),
                         platform = COALESCE($6, contact_settings.platform),
                         display_name = COALESCE($7, contact_settings.display_name),
                         updated_at = now()
           RETURNING target_type, target_id, display_name, routing, permission, download_media, platform`,
          [userId, resolved.targetType, resolved.targetId, args.routing ?? null, args.download_media ?? null, args.platform ?? null, resolved.displayName],
        );
        appliedRow = result.rows[0];

        const changes = [
          applyRouting ? `routing=${args.routing}` : null,
          applyMedia ? `media=${args.download_media}` : null,
        ].filter(Boolean).join(', ');

        logAudit({
          user_id: userId,
          source: 'messaging',
          action: 'update',
          entity_type: 'contact_settings',
          entity_id: `${resolved.targetType}:${resolved.targetId}`,
          summary: `Set ${resolved.targetType} ${(appliedRow?.display_name as string | null) ?? resolved.targetId}: ${changes}`,
          metadata: { target_type: resolved.targetType, target_id: resolved.targetId, routing: args.routing, download_media: args.download_media },
        });
      }

      // If permission was requested, defer it to human approval (never applied here).
      let permissionRequest: { requestId: string; currentPermission: string | null } | undefined;
      if (args.permission !== undefined) {
        permissionRequest = await filePermissionChangeRequest(pool, {
          userId,
          platform: args.platform,
          conversationId: args.conversation_id,
          targetType: resolved.targetType,
          targetId: resolved.targetId,
          displayName: resolved.displayName,
          requestedPermission: args.permission,
        });

        logAudit({
          user_id: userId,
          source: 'messaging',
          action: 'permission_change_requested',
          entity_type: 'contact_settings',
          entity_id: `${resolved.targetType}:${resolved.targetId}`,
          summary: `Requested authority change for ${resolved.targetType} ${resolved.displayName ?? resolved.targetId}: ${permissionRequest.currentPermission ?? 'default'} → ${args.permission} (pending fingerprint approval)`,
          metadata: { target_type: resolved.targetType, target_id: resolved.targetId, requested_permission: args.permission, current_permission: permissionRequest.currentPermission, request_id: permissionRequest.requestId },
        });
      }

      const payload: Record<string, unknown> = { success: true };
      if (appliedRow) {
        payload.applied = appliedRow;
      }
      if (permissionRequest) {
        payload.permission_pending_approval = true;
        payload.permission_request_id = permissionRequest.requestId;
        payload.requested_permission = args.permission;
        payload.current_permission = permissionRequest.currentPermission;
        payload.message = applyNow
          ? "Routing/download applied. The permission (Authority) change requires your fingerprint approval on the phone — NOT applied; the conversation's authority is unchanged until you approve."
          : "Permission change requires your fingerprint approval on the phone — NOT applied. The conversation's authority is unchanged until you approve.";
      }

      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    },
  );
}
