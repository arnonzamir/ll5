import { BasePostgresRepository } from './base.repository.js';
import type {
  ConversationRepository,
  ConversationRecord,
  ConversationListParams,
  ConversationListResult,
} from '../interfaces/conversation.repository.js';

// The conversation row no longer stores `permission` (dropped in migration 005).
// Authority (read / reply) is resolved from contact_settings — the single source
// of truth written by the dashboard Authority control, set_contact_settings, and
// update_conversation_permissions, and read by the permission checker. A 1:1 chat
// keys on its linked KB person_id; a group (or unlinked chat) keys on the JID.
// No row multiplication: messaging_contacts and contact_settings are both unique
// on their join keys, and the OR matches exactly one branch per conversation.
const PERMISSION_JOIN = `
  LEFT JOIN messaging_contacts mct
    ON mct.user_id = c.user_id AND mct.platform = c.platform AND mct.platform_id = c.conversation_id
  LEFT JOIN contact_settings cs
    ON cs.user_id = c.user_id::uuid
    AND (
      (c.is_group = true  AND cs.target_type = 'group'  AND cs.target_id = c.conversation_id)
      OR
      (c.is_group = false AND cs.target_type = 'person' AND cs.target_id = mct.person_id)
    )`;

// COALESCE default mirrors the permission checker: no contact_settings row → 'input'
// (read OK, send blocked).
const SELECT_COLS = `
  c.id, c.user_id, c.account_id, c.platform, c.conversation_id, c.name,
  c.is_group, c.is_archived, c.unread_count, c.last_message_at, c.created_at, c.updated_at,
  COALESCE(cs.permission, 'input') AS permission`;

export class PostgresConversationRepository
  extends BasePostgresRepository
  implements ConversationRepository
{
  async list(userId: string, params?: ConversationListParams): Promise<ConversationListResult> {
    const conditions: string[] = ['c.user_id = $1'];
    const values: unknown[] = [userId];
    let paramIndex = 2;

    if (params?.platform) {
      conditions.push(`c.platform = $${paramIndex++}`);
      values.push(params.platform);
    }
    if (params?.account_id) {
      conditions.push(`c.account_id = $${paramIndex++}`);
      values.push(params.account_id);
    }
    if (params?.is_group !== undefined) {
      conditions.push(`c.is_group = $${paramIndex++}`);
      values.push(params.is_group);
    }
    if (params?.query) {
      conditions.push(
        `(c.name ILIKE $${paramIndex} OR c.conversation_id ILIKE $${paramIndex})`,
      );
      values.push(`%${params.query}%`);
      paramIndex++;
    }
    if (params?.permission) {
      // Authority lives in contact_settings (see PERMISSION_JOIN), not on the
      // conversation row — filter the joined value, with the same default.
      conditions.push(`COALESCE(cs.permission, 'input') = $${paramIndex++}`);
      values.push(params.permission);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM messaging_conversations c ${PERMISSION_JOIN} WHERE ${whereClause}`,
      [...values],
    );
    const total = parseInt(countResult[0]?.count ?? '0', 10);

    const limit = params?.limit ?? 500;
    const offset = params?.offset ?? 0;

    const sql = `
      SELECT ${SELECT_COLS}
      FROM messaging_conversations c
      ${PERMISSION_JOIN}
      WHERE ${whereClause}
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    values.push(limit, offset);

    const conversations = await this.query<ConversationRecord>(sql, values);
    return { conversations, total };
  }

  async get(
    userId: string,
    platform: string,
    conversationId: string,
  ): Promise<ConversationRecord | null> {
    return this.queryOne<ConversationRecord>(
      `SELECT ${SELECT_COLS}
       FROM messaging_conversations c
       ${PERMISSION_JOIN}
       WHERE c.user_id = $1 AND c.platform = $2 AND c.conversation_id = $3`,
      [userId, platform, conversationId],
    );
  }

  async upsert(
    userId: string,
    conversation: {
      account_id: string;
      platform: string;
      conversation_id: string;
      name: string;
      is_group: boolean;
      is_archived?: boolean;
      unread_count?: number;
    },
  ): Promise<{ created: boolean }> {
    // Use INSERT ... ON CONFLICT to upsert conversation metadata only. Authority
    // lives in contact_settings, so sync never touches it.
    const result = await this.query<{ xmax: string }>(
      `INSERT INTO messaging_conversations
         (user_id, account_id, platform, conversation_id, name, is_group, is_archived, unread_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, platform, conversation_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         is_group = EXCLUDED.is_group,
         is_archived = EXCLUDED.is_archived,
         unread_count = EXCLUDED.unread_count,
         account_id = EXCLUDED.account_id,
         updated_at = now()
       RETURNING xmax`,
      [
        userId,
        conversation.account_id,
        conversation.platform,
        conversation.conversation_id,
        conversation.name,
        conversation.is_group,
        conversation.is_archived ?? false,
        conversation.unread_count ?? 0,
      ],
    );

    // xmax = 0 means INSERT (new row), xmax > 0 means UPDATE (existing row)
    const row = result[0];
    const created = row ? row.xmax === '0' : false;
    return { created };
  }

  async touchLastMessage(
    userId: string,
    platform: string,
    conversationId: string,
    timestamp: Date,
  ): Promise<void> {
    await this.query(
      `UPDATE messaging_conversations
       SET last_message_at = $1, updated_at = now()
       WHERE user_id = $2 AND platform = $3 AND conversation_id = $4`,
      [timestamp, userId, platform, conversationId],
    );
  }
}
