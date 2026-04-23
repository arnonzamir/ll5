import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import { logger } from './logger.js';

interface ExportSection {
  name: string;
  count: number;
  data: unknown[];
}

/**
 * Export all user data from ES indices and PG tables.
 * Skips media files (binary). Limits large indices.
 */
export async function exportUserData(
  es: Client,
  pool: Pool,
  userId: string,
): Promise<ExportSection[]> {
  const sections: ExportSection[] = [];

  // ES indices to export (no media — binary files not exportable as JSON)
  const esIndices = [
    { name: 'knowledge_facts', index: 'll5_knowledge_facts', limit: 5000 },
    { name: 'knowledge_people', index: 'll5_knowledge_people', limit: 1000 },
    { name: 'knowledge_places', index: 'll5_knowledge_places', limit: 1000 },
    { name: 'knowledge_profile', index: 'll5_knowledge_profile', limit: 10 },
    { name: 'knowledge_data_gaps', index: 'll5_knowledge_data_gaps', limit: 500 },
    { name: 'awareness_locations', index: 'll5_awareness_locations', limit: 5000 },
    { name: 'awareness_messages', index: 'll5_awareness_messages', limit: 5000 },
    { name: 'awareness_entity_statuses', index: 'll5_awareness_entity_statuses', limit: 1000 },
    { name: 'awareness_calendar_events', index: 'll5_awareness_calendar_events', limit: 2000 },
    { name: 'awareness_notable_events', index: 'll5_awareness_notable_events', limit: 1000 },
    { name: 'agent_journal', index: 'll5_agent_journal', limit: 2000 },
    { name: 'agent_user_model', index: 'll5_agent_user_model', limit: 50 },
    { name: 'agent_user_model_history', index: 'll5_agent_user_model_history', limit: 200 },
    { name: 'health_sleep', index: 'll5_health_sleep', limit: 1000 },
    { name: 'health_heart_rate', index: 'll5_health_heart_rate', limit: 1000 },
    { name: 'health_daily_stats', index: 'll5_health_daily_stats', limit: 1000 },
    { name: 'health_activities', index: 'll5_health_activities', limit: 2000 },
    { name: 'health_body_composition', index: 'll5_health_body_composition', limit: 500 },
  ];

  for (const { name, index, limit } of esIndices) {
    try {
      const exists = await es.indices.exists({ index });
      if (!exists) continue;

      const result = await es.search(
        {
          index,
          query: { term: { user_id: userId } },
          size: limit,
          sort: [{ _doc: { order: 'desc' } }],
          _source: { excludes: ['raw_data', 'readings', 'stress_readings'] },
        },
        { requestTimeout: 10000 },
      );

      const docs = result.hits.hits.map((h) => ({
        _id: h._id,
        ...h._source as Record<string, unknown>,
      }));

      sections.push({ name, count: docs.length, data: docs });
      logger.info(`[export] Exported ${name}: ${docs.length} docs`);
    } catch (err) {
      logger.warn(`[export] Failed to export ${name}`, { error: err instanceof Error ? err.message : String(err) });
      sections.push({ name, count: 0, data: [] });
    }
  }

  // PG tables
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
      sections.push({ name, count: result.rows.length, data: result.rows });
      logger.info(`[export] Exported ${name}: ${result.rows.length} rows`);
    } catch (err) {
      logger.warn(`[export] Failed to export ${name}`, { error: err instanceof Error ? err.message : String(err) });
      sections.push({ name, count: 0, data: [] });
    }
  }

  return sections;
}
