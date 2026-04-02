import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';

const MULTILINGUAL_SETTINGS = {
  analysis: {
    analyzer: {
      multilingual: {
        type: 'custom' as const,
        tokenizer: 'standard',
        filter: ['lowercase', 'asciifolding'],
      },
    },
  },
};

const INDEX_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 1,
  ...MULTILINGUAL_SETTINGS,
};

interface IndexDefinition {
  index: string;
  mappings: Record<string, unknown>;
}

const INDICES: IndexDefinition[] = [
  {
    index: 'll5_awareness_locations',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        location: { type: 'geo_point' },
        accuracy: { type: 'float' },
        speed: { type: 'float' },
        address: { type: 'text' },
        matched_place_id: { type: 'keyword' },
        matched_place: { type: 'keyword' },
        device_timezone: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_messages',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        sender: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        app: { type: 'keyword' },
        content: { type: 'text', analyzer: 'multilingual' },
        conversation_id: { type: 'keyword' },
        conversation_name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        is_group: { type: 'boolean' },
        processed: { type: 'boolean' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_entity_statuses',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        entity_name: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
        summary: { type: 'text', analyzer: 'multilingual' },
        location: { type: 'text' },
        activity: { type: 'text' },
        source: { type: 'keyword' },
        source_message_id: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_calendar_events',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        title: { type: 'text', analyzer: 'multilingual', fields: { keyword: { type: 'keyword' } } },
        description: { type: 'text', analyzer: 'multilingual' },
        start_time: { type: 'date' },
        end_time: { type: 'date' },
        location: { type: 'text' },
        calendar_name: { type: 'keyword' },
        source: { type: 'keyword' },
        all_day: { type: 'boolean' },
        attendees: { type: 'keyword' },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_notable_events',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        event_type: { type: 'keyword' },
        summary: { type: 'text', analyzer: 'multilingual' },
        severity: { type: 'keyword' },
        payload: { type: 'object', enabled: false },
        acknowledged: { type: 'boolean' },
        acknowledged_at: { type: 'date' },
        created_at: { type: 'date' },
      },
    },
  },
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
  for (const def of INDICES) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      logger.info(`[ensureIndices][create] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: INDEX_SETTINGS,
        mappings: def.mappings,
      });
      logger.info(`[ensureIndices][create] Index created: ${def.index}`);
    } else {
      logger.debug(`[ensureIndices][create] Index already exists: ${def.index}`);
    }
  }
}
