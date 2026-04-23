import type { IndexDefinition } from './awareness.js';

/**
 * ll5_knowledge_networks is owned by the personal-knowledge MCP but the gateway
 * writes to it from its wifi processor (auto-learning BSSID → place co-occurrence
 * with GPS). Shared here to avoid drift between the two index definitions.
 */
export const KNOWLEDGE_NETWORKS_INDEX: IndexDefinition = {
  index: 'll5_knowledge_networks',
  mappings: {
    properties: {
      user_id: { type: 'keyword' },
      bssid: { type: 'keyword' },
      ssid: { type: 'text', fields: { keyword: { type: 'keyword' } } },
      place_observations: {
        type: 'nested',
        properties: {
          place_id: { type: 'keyword' },
          place_name: { type: 'keyword' },
          count: { type: 'integer' },
          last_seen: { type: 'date' },
        },
      },
      manual_place_id: { type: 'keyword' },
      manual_place_name: { type: 'keyword' },
      label: { type: 'text' },
      total_observations: { type: 'integer' },
      first_seen: { type: 'date' },
      last_seen: { type: 'date' },
      created_at: { type: 'date' },
      updated_at: { type: 'date' },
    },
  },
};
