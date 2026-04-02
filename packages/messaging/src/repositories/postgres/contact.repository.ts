import { BasePostgresRepository } from './base.repository.js';
import type {
  ContactRepository,
  ContactRecord,
  ContactUpsertInput,
  ContactListParams,
  ContactListResult,
} from '../interfaces/contact.repository.js';
import { logger } from '../../utils/logger.js';

export class PostgresContactRepository
  extends BasePostgresRepository
  implements ContactRepository
{
  async upsert(userId: string, contact: ContactUpsertInput): Promise<ContactRecord> {
    const row = await this.queryOne<ContactRecord>(
      `INSERT INTO messaging_contacts
         (user_id, platform, platform_id, display_name, phone_number, is_group, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (user_id, platform, platform_id)
       DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, messaging_contacts.display_name),
         phone_number = COALESCE(EXCLUDED.phone_number, messaging_contacts.phone_number),
         is_group = EXCLUDED.is_group,
         last_seen_at = now(),
         updated_at = now()
       RETURNING *`,
      [
        userId,
        contact.platform,
        contact.platform_id,
        contact.display_name ?? null,
        contact.phone_number ?? null,
        contact.is_group ?? false,
      ],
    );

    if (!row) {
      throw new Error('[PostgresContactRepository][upsert] INSERT did not return a row');
    }

    return row;
  }

  async bulkUpsert(userId: string, contacts: ContactUpsertInput[]): Promise<number> {
    if (contacts.length === 0) return 0;

    // Build a single multi-row INSERT for efficiency
    const values: unknown[] = [userId];
    const rows: string[] = [];
    let paramIndex = 2;

    for (const contact of contacts) {
      rows.push(
        `($1, $${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, now())`,
      );
      values.push(
        contact.platform,
        contact.platform_id,
        contact.display_name ?? null,
        contact.phone_number ?? null,
        contact.is_group ?? false,
      );
      paramIndex += 5;
    }

    const result = await this.query<{ id: string }>(
      `INSERT INTO messaging_contacts
         (user_id, platform, platform_id, display_name, phone_number, is_group, last_seen_at)
       VALUES ${rows.join(', ')}
       ON CONFLICT (user_id, platform, platform_id)
       DO UPDATE SET
         display_name = COALESCE(EXCLUDED.display_name, messaging_contacts.display_name),
         phone_number = COALESCE(EXCLUDED.phone_number, messaging_contacts.phone_number),
         is_group = EXCLUDED.is_group,
         last_seen_at = now(),
         updated_at = now()
       RETURNING id`,
      values,
    );

    logger.info('[PostgresContactRepository][bulkUpsert] Contacts upserted', {
      requested: contacts.length,
      affected: result.length,
    });

    return result.length;
  }

  async list(userId: string, params?: ContactListParams): Promise<ContactListResult> {
    const conditions: string[] = ['user_id = $1'];
    const values: unknown[] = [userId];
    let paramIndex = 2;

    if (params?.platform) {
      conditions.push(`platform = $${paramIndex++}`);
      values.push(params.platform);
    }

    if (params?.query) {
      conditions.push(
        `(display_name ILIKE $${paramIndex} OR phone_number ILIKE $${paramIndex})`,
      );
      values.push(`%${params.query}%`);
      paramIndex++;
    }

    if (params?.hasPersonLink === true) {
      conditions.push('person_id IS NOT NULL');
    } else if (params?.hasPersonLink === false) {
      conditions.push('person_id IS NULL');
    }

    if (params?.is_group !== undefined) {
      conditions.push(`is_group = $${paramIndex++}`);
      values.push(params.is_group);
    }

    const whereClause = conditions.join(' AND ');

    // Get total count
    const countResult = await this.query<{ count: string }>(
      `SELECT COUNT(*) as count FROM messaging_contacts WHERE ${whereClause}`,
      [...values],
    );
    const total = parseInt(countResult[0]?.count ?? '0', 10);

    const limit = params?.limit ?? 100;
    const offset = params?.offset ?? 0;

    const sql = `
      SELECT * FROM messaging_contacts
      WHERE ${whereClause}
      ORDER BY display_name ASC NULLS LAST, last_seen_at DESC NULLS LAST
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    values.push(limit, offset);

    const contacts = await this.query<ContactRecord>(sql, values);
    return { contacts, total };
  }

  async resolve(
    userId: string,
    platform: string,
    platformId: string,
  ): Promise<ContactRecord | null> {
    return this.queryOne<ContactRecord>(
      `SELECT * FROM messaging_contacts
       WHERE user_id = $1 AND platform = $2 AND platform_id = $3`,
      [userId, platform, platformId],
    );
  }

  async linkPerson(userId: string, contactId: string, personId: string): Promise<void> {
    const result = await this.query<{ id: string }>(
      `UPDATE messaging_contacts
       SET person_id = $1, updated_at = now()
       WHERE user_id = $2 AND id = $3
       RETURNING id`,
      [personId, userId, contactId],
    );

    if (result.length === 0) {
      throw new Error('CONTACT_NOT_FOUND');
    }
  }

  async unlinkPerson(userId: string, contactId: string): Promise<void> {
    const result = await this.query<{ id: string }>(
      `UPDATE messaging_contacts
       SET person_id = NULL, updated_at = now()
       WHERE user_id = $1 AND id = $2
       RETURNING id`,
      [userId, contactId],
    );

    if (result.length === 0) {
      throw new Error('CONTACT_NOT_FOUND');
    }
  }
}
