import type { Client } from '@elastic/elasticsearch';

export interface IndexDefinition {
  index: string;
  mappings: Record<string, unknown>;
}

export const MULTILINGUAL_SETTINGS = {
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

export const AWARENESS_INDEX_SETTINGS = {
  number_of_shards: 1,
  number_of_replicas: 1,
  ...MULTILINGUAL_SETTINGS,
};

/**
 * Canonical definitions for the 7 awareness-* indices shared between the
 * gateway (writer) and the awareness MCP (reader, occasional writer).
 *
 * Previously defined separately in gateway/src/server.ts and
 * awareness/src/setup/indices.ts, which allowed drift — notably the
 * notable_events index had two incompatible schemas.
 */
export const AWARENESS_INDICES: IndexDefinition[] = [
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
        battery_pct: { type: 'float' },
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
        group_name: { type: 'keyword' },
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
        entity_name: {
          type: 'text',
          analyzer: 'multilingual',
          fields: { keyword: { type: 'keyword' } },
        },
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
        title: {
          type: 'text',
          analyzer: 'multilingual',
          fields: { keyword: { type: 'keyword' } },
        },
        description: { type: 'text', analyzer: 'multilingual' },
        start_time: { type: 'date' },
        end_time: { type: 'date' },
        location: { type: 'text' },
        calendar_name: { type: 'keyword' },
        calendar_id: { type: 'keyword' },
        calendar_color: { type: 'keyword' },
        google_event_id: { type: 'keyword' },
        html_link: { type: 'keyword' },
        source: { type: 'keyword' },
        status: { type: 'keyword' },
        all_day: { type: 'boolean' },
        recurring: { type: 'boolean' },
        is_free_busy: { type: 'boolean' },
        is_tickler: { type: 'boolean' },
        attendees: { type: 'keyword' },
        attendees_detail: { type: 'object', enabled: false },
        created_at: { type: 'date' },
        updated_at: { type: 'date' },
      },
    },
  },
  {
    // Canonical shape matches awareness MCP's existing reader:
    // the gateway previously wrote a different shape (place_id / place_name /
    // location / details / timestamp), which was silently invisible to
    // get_notable_events because the reader filters on `acknowledged: false`
    // and sorts on `created_at`. Writers MUST use this shape going forward;
    // place-specific data lives inside `payload`.
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
    index: 'll5_awareness_phone_statuses',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        battery_pct: { type: 'float' },
        is_charging: { type: 'boolean' },
        plug_type: { type: 'keyword' },
        battery_temp_c: { type: 'float' },
        battery_health: { type: 'keyword' },
        low_power_mode: { type: 'boolean' },
        storage_used_bytes: { type: 'long' },
        storage_total_bytes: { type: 'long' },
        ram_used_bytes: { type: 'long' },
        ram_total_bytes: { type: 'long' },
        trigger: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
  {
    index: 'll5_awareness_wifi_connections',
    mappings: {
      properties: {
        user_id: { type: 'keyword' },
        ssid: { type: 'text', fields: { keyword: { type: 'keyword' } } },
        bssid: { type: 'keyword' },
        rssi_dbm: { type: 'integer' },
        frequency_mhz: { type: 'integer' },
        link_speed_mbps: { type: 'integer' },
        ip_address: { type: 'keyword' },
        connected: { type: 'boolean' },
        trigger: { type: 'keyword' },
        timestamp: { type: 'date' },
      },
    },
  },
];

/**
 * Idempotent index ensurer. Logs via the caller-provided logger so each
 * service's log stream carries its own context.
 */
export async function ensureAwarenessIndices(
  client: Client,
  log: { info: (msg: string) => void; debug: (msg: string) => void },
): Promise<void> {
  for (const def of AWARENESS_INDICES) {
    const exists = await client.indices.exists({ index: def.index });
    if (!exists) {
      log.info(`[ensureAwarenessIndices] Creating index: ${def.index}`);
      await client.indices.create({
        index: def.index,
        settings: AWARENESS_INDEX_SETTINGS,
        mappings: def.mappings,
      });
      log.info(`[ensureAwarenessIndices] Index created: ${def.index}`);
    } else {
      log.debug(`[ensureAwarenessIndices] Index already exists: ${def.index}`);
    }
  }
}
