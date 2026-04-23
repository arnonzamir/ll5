import type { Client } from '@elastic/elasticsearch';
import {
  AWARENESS_INDICES,
  AWARENESS_INDEX_SETTINGS,
  type IndexDefinition,
} from '@ll5/shared';
import { logger } from '../utils/logger.js';

// Indices exclusively owned by the awareness MCP (not written to by the gateway).
// The 7 ll5_awareness_* indices that the gateway also writes to are imported
// from @ll5/shared to prevent schema drift.
const AWARENESS_EXCLUSIVE_INDICES: IndexDefinition[] = [
  {
    index: 'll5_agent_journal',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        type: { type: 'keyword' },
        topic: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        content: { type: 'text', analyzer: 'multilingual' },
        signal: { type: 'keyword' },
        status: { type: 'keyword' },
        session_id: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_agent_user_model',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        section: { type: 'keyword' },
        content: { type: 'object', enabled: false },
        last_updated: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_media',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        url: { type: 'keyword' },
        mime_type: { type: 'keyword' },
        filename: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        size_bytes: { type: 'integer' },
        description: { type: 'text', analyzer: 'multilingual' },
        source: { type: 'keyword' },
        tags: { type: 'keyword' },
        created_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_media_links',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        media_id: { type: 'keyword' },
        entity_type: { type: 'keyword' },
        entity_id: { type: 'keyword' },
        linked_at: { type: 'date' },
      },
    },
  },
];

export async function ensureIndices(client: Client): Promise<void> {
  const all = [...AWARENESS_INDICES, ...AWARENESS_EXCLUSIVE_INDICES];
  for (const def of all) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: AWARENESS_INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      logger.debug(`[ensureIndices][create] Index already exists: ${def.index}`);
    }
  }
}
