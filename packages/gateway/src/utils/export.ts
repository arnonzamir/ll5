import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from './logger.js';

interface ExportSection {
  name: string;
  data: unknown[];
}

/**
 * Export all user data from ES indices and PG tables.
 * Returns an array of named sections, each with its data.
 */
export async function exportUserData(
  es: Client,
  pool: Pool,
  userId: string,
): Promise<ExportSection[]> {
  const sections: ExportSection[] = [];

  // ES indices to export
  const esIndices = [
    { name: 'knowledge_facts', index: 'll5_knowledge_facts' },
    { name: 'knowledge_people', index: 'll5_knowledge_people' },
    { name: 'knowledge_places', index: 'll5_knowledge_places' },
    { name: 'knowledge_profile', index: 'll5_knowledge_profile' },
    { name: 'knowledge_data_gaps', index: 'll5_knowledge_data_gaps' },
    { name: 'awareness_locations', index: 'll5_awareness_locations' },
    { name: 'awareness_messages', index: 'll5_awareness_messages' },
    { name: 'awareness_entity_statuses', index: 'll5_awareness_entity_statuses' },
    { name: 'awareness_calendar_events', index: 'll5_awareness_calendar_events' },
    { name: 'awareness_notable_events', index: 'll5_awareness_notable_events' },
    { name: 'agent_journal', index: 'll5_agent_journal' },
    { name: 'agent_user_model', index: 'll5_agent_user_model' },
    { name: 'health_sleep', index: 'll5_health_sleep' },
    { name: 'health_heart_rate', index: 'll5_health_heart_rate' },
    { name: 'health_daily_stats', index: 'll5_health_daily_stats' },
    { name: 'health_activities', index: 'll5_health_activities' },
    { name: 'health_body_composition', index: 'll5_health_body_composition' },
    { name: 'media', index: 'll5_media' },
    { name: 'media_links', index: 'll5_media_links' },
  ];

  for (const { name, index } of esIndices) {
    try {
      const exists = await es.indices.exists({ index });
      if (!exists) continue;

      const result = await es.search({
        index,
        query: { term: { user_id: userId } },
        size: 10000,
        _source: { excludes: ['raw_data'] },
      });

      const docs = result.hits.hits.map((h) => ({
        _id: h._id,
        ...h._source as Record<string, unknown>,
      }));

      if (docs.length > 0) {
        sections.push({ name, data: docs });
      }
    } catch (err) {
      logger.warn(`[export] Failed to export ${index}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  // PG tables to export
  const pgTables = [
    { name: 'gtd_horizons', query: 'SELECT * FROM gtd_horizons WHERE user_id = $1' },
    { name: 'gtd_inbox', query: 'SELECT * FROM gtd_inbox WHERE user_id = $1' },
    { name: 'chat_messages', query: 'SELECT id, conversation_id, channel, direction, role, content, status, created_at FROM chat_messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5000' },
    { name: 'notification_rules', query: 'SELECT * FROM notification_rules WHERE user_id = $1' },
    { name: 'user_settings', query: 'SELECT * FROM user_settings WHERE user_id = $1' },
  ];

  for (const { name, query } of pgTables) {
    try {
      const result = await pool.query(query, [userId]);
      if (result.rows.length > 0) {
        sections.push({ name, data: result.rows });
      }
    } catch (err) {
      logger.warn(`[export] Failed to export ${name}`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return sections;
}
