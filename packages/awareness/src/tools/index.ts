import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import type { LocationRepository } from '../repositories/interfaces/location.repository.js';
import type { MessageRepository } from '../repositories/interfaces/message.repository.js';
import type { EntityStatusRepository } from '../repositories/interfaces/entity-status.repository.js';
import type { CalendarEventRepository } from '../repositories/interfaces/calendar-event.repository.js';
import type { NotableEventRepository } from '../repositories/interfaces/notable-event.repository.js';
import type { PhoneStatusRepository } from '../repositories/interfaces/phone-status.repository.js';
import type { WifiRepository } from '../repositories/interfaces/wifi.repository.js';
import type { WifiScanRepository } from '../repositories/interfaces/wifi-scan.repository.js';
import type { TrackedDeviceRepository } from '../repositories/interfaces/tracked-device.repository.js';
import type { DeviceActivityRepository } from '../repositories/interfaces/device-activity.repository.js';
import type { BluetoothRepository } from '../repositories/interfaces/bluetooth.repository.js';
import { LocationService } from '../services/location-service.js';
import { registerLocationTools } from './location.js';
import { registerMessageTools } from './messages.js';
import { registerEntityStatusTools } from './entity-statuses.js';
import { registerNotableEventTools } from './notable-events.js';
import { registerSituationTools } from './situation.js';
import { registerJournalTools } from './journal.js';
import { registerLessonTools } from './lessons.js';
import { registerWakeTools } from './wakes.js';
import { registerRecallEverythingTool } from './recall-everything.js';
import { registerMediaTools } from './media.js';
import { registerGeoSearchTools } from './geo-search.js';
import { registerPhoneStatusTools } from './phone-status.js';
import { registerWifiTools } from './wifi.js';
import { registerTrackedDeviceTools } from './tracked-devices.js';

export interface Repositories {
  location: LocationRepository;
  message: MessageRepository;
  entityStatus: EntityStatusRepository;
  calendar: CalendarEventRepository;
  notableEvent: NotableEventRepository;
  phoneStatus: PhoneStatusRepository;
  wifi: WifiRepository;
  wifiScan: WifiScanRepository;
  trackedDevice: TrackedDeviceRepository;
  deviceActivity: DeviceActivityRepository;
  bluetooth: BluetoothRepository;
}

export function registerAllTools(
  server: McpServer,
  repos: Repositories,
  getUserId: () => string,
  timezone: string,
  gatewayUrl?: string,
  authSecret?: string,
  esClient?: Client,
): void {
  if (!esClient) {
    throw new Error('esClient is required for LocationService');
  }
  const locationService = new LocationService(repos.location, repos.wifi, esClient, repos.wifiScan);
  registerLocationTools(server, repos.location, getUserId, locationService, esClient);
  registerMessageTools(server, repos.message, getUserId);
  registerEntityStatusTools(server, repos.entityStatus, getUserId);
  // Calendar tools retired — unified calendar reads/writes go through the calendar MCP
  registerNotableEventTools(server, repos.notableEvent, getUserId);
  registerSituationTools(
    server,
    {
      location: repos.location,
      calendar: repos.calendar,
      notableEvent: repos.notableEvent,
      message: repos.message,
      deviceActivity: repos.deviceActivity,
      bluetooth: repos.bluetooth,
    },
    getUserId,
    timezone,
    locationService,
    gatewayUrl,
    authSecret,
  );
  if (esClient) {
    registerJournalTools(server, esClient, getUserId);
    registerLessonTools(server, esClient, getUserId);
    registerRecallEverythingTool(server, esClient, getUserId);
    registerMediaTools(server, esClient, getUserId);
    registerWakeTools(server, esClient, getUserId);
  }
  registerGeoSearchTools(server, getUserId);
  registerPhoneStatusTools(server, repos.phoneStatus, getUserId);
  registerWifiTools(server, repos.wifi, getUserId);
  registerTrackedDeviceTools(server, repos.trackedDevice, getUserId);
}
