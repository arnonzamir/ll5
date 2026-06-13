import type { Client } from '@elastic/elasticsearch';
import { BaseElasticsearchRepository } from './base.repository.js';
import type { EsQueryContainer } from './base.repository.js';
import type { DeviceActivityRepository } from '../interfaces/device-activity.repository.js';
import type {
  DeviceActivity,
  DeviceActivityQuery,
  TopApp,
} from '../../types/device-activity.js';

const INDEX = 'll5_awareness_device_activity';

interface TopAppDoc {
  package: string;
  app_name?: string;
  category?: string;
  foreground_ms?: number;
  opens?: number;
}

interface DeviceActivityDoc {
  user_id: string;
  window_start: string;
  window_end: string;
  screen_on_ms?: number;
  unlock_count?: number;
  first_interaction?: string;
  last_interaction?: string;
  interactive_now?: boolean;
  top_apps?: TopAppDoc[];
  timestamp: string;
}

function docToTopApp(a: TopAppDoc): TopApp {
  return {
    package: a.package,
    appName: a.app_name,
    category: a.category,
    foregroundMs: a.foreground_ms,
    opens: a.opens,
  };
}

function docToDeviceActivity(
  id: string,
  doc: DeviceActivityDoc,
  userId: string,
): DeviceActivity {
  return {
    id,
    userId,
    windowStart: doc.window_start,
    windowEnd: doc.window_end,
    screenOnMs: doc.screen_on_ms,
    unlockCount: doc.unlock_count,
    firstInteraction: doc.first_interaction,
    lastInteraction: doc.last_interaction,
    interactiveNow: doc.interactive_now,
    topApps: doc.top_apps?.map(docToTopApp),
    timestamp: doc.timestamp,
  };
}

export class ElasticsearchDeviceActivityRepository
  extends BaseElasticsearchRepository
  implements DeviceActivityRepository
{
  constructor(client: Client) {
    super(client, INDEX);
  }

  async getLatest(userId: string): Promise<DeviceActivity | null> {
    const { hits } = await this.searchDocs<DeviceActivityDoc>(userId, {
      filters: [],
      size: 1,
      sort: [{ timestamp: { order: 'desc' } }],
    });
    if (hits.length === 0 || !hits[0]?._source) return null;
    return docToDeviceActivity(hits[0]._id!, hits[0]._source, userId);
  }

  async query(userId: string, query: DeviceActivityQuery): Promise<DeviceActivity[]> {
    const filters: EsQueryContainer[] = [];
    if (query.startTime || query.endTime) {
      const range: Record<string, string> = {};
      if (query.startTime) range.gte = query.startTime;
      if (query.endTime) range.lte = query.endTime;
      filters.push({ range: { timestamp: range } });
    }

    const { hits } = await this.searchDocs<DeviceActivityDoc>(userId, {
      filters,
      size: query.limit ?? 100,
      from: query.offset ?? 0,
      sort: [{ timestamp: { order: 'desc' } }],
    });

    return hits
      .filter((h) => h._source != null)
      .map((h) => docToDeviceActivity(h._id!, h._source!, userId));
  }
}
