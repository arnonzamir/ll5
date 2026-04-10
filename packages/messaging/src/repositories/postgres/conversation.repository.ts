import { BasePostgresRepository } from './base.repository.js';
import type {
  ConversationRepository,
  ConversationRecord,
  ConversationListParams,
  ConversationListResult,
} from '../interfaces/conversation.repository.js';

export class PostgresConversationRepository
  extends BasePostgresRepository
  implements ConversationRepository
{
  async list(userId: string, params?: ConversationListParams): Promise<ConversationListResult> {
    const conditions: string[] = ['user_id = $1'];
    const values: unknown[] = [userId];
    let paramIndex = 2;

    if (params?.platform) {
      conditions.push(`platform = $${paramIndex++}`);
      values.push(params.platform);
    }
    if (params?.permission) {
      conditions.push(`permission = $${paramIndex++}`);
      values.push(params.permission);
    }
    if (params?.account_id) {
      conditions.push(`account_id = $${paramIndex++}`);
      values.push(params.account_id);
    }
    if (params?.is_group !== undefined) {
      conditions.push(`is_group = $${paramIndex++}`);
      values.push(params.is_group);
    }
    if (params?.query) {
      conditions.push(
        `(name ILIKE $${paramIndex} OR conversation_id ILIKE $${paramIndex})`,
      );
      values.push(`%${params.query}%`);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM messaging_conversations WHERE ${whereClause}`,
      [...values],
    );
    const total = parseInt(countResult[0]?.count ?? '0', 10);

    const limit = params?.limit ?? 500;
    const offset = params?.offset ?? 0;

    const sql = `
      SELECT * FROM messaging_conversations
      WHERE ${whereClause}
      ORDER BY last_message_at DESC NULLS LAST, created_at DESC
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
      `SELECT * FROM messaging_conversations
       WHERE user_id = $1 AND platform = $2 AND conversation_id = $3`,
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
    // Use INSERT ... ON CONFLICT to upsert. Preserve existing permission.
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

  async updatePermission(
    userId: string,
    platform: string,
    conversationId: string,
    permission: 'agent' | 'input' | 'ignore',
  ): Promise<{ previous_permission: string }> {
    const existing = await this.get(userId, platform, conversationId);
    if (!existing) {
      throw new Error('CONVERSATION_NOT_FOUND');
    }

    const previousPermission = existing.permission;

    await this.query(
      `UPDATE messaging_conversations
       SET permission = $1, updated_at = now()
       WHERE user_id = $2 AND platform = $3 AND conversation_id = $4`,
      [permission, userId, platform, conversationId],
    );

    return { previous_permission: previousPermission };
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
