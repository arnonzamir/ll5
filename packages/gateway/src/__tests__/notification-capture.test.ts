import { describe, it, expect } from 'vitest';
import {
  decideNotificationRoute,
  buildNotificationDoc,
  IM_PACKAGES,
} from '../processors/app-notification.js';
import {
  connectorCaptureCommands,
  connectorIdFromSourceKey,
  notificationCaptureSeed,
} from '../utils/notification-capture.js';
import { CONNECTOR_CATALOG } from '@ll5/shared';
import type { PushAppNotificationItem } from '../types/index.js';

const CAL = 'com.onoapps.cal4u';
const WOLT = 'com.wolt.android';
const WHATSAPP = 'com.whatsapp';

describe('app_notification routing decision table (pure)', () => {
  const rows: Array<[string, string, boolean, boolean, string | null, boolean]> = [
    // label, package, connector_<id> on, notifications_all on, → connector id handed to parser, stored
    ['connector on / all on', CAL, true, true, 'cal', true],
    ['connector on / all off', CAL, true, false, 'cal', false],
    ['connector off / all on', CAL, false, true, null, true],
    ['connector off / all off', CAL, false, false, null, false],
    ['IM / on / on', WHATSAPP, true, true, null, false],
    ['IM / off / off', WHATSAPP, false, false, null, false],
    ['other app / all on', WOLT, true, true, null, true],
    ['other app / all off', WOLT, true, false, null, false],
  ];
  for (const [label, pkg, connectorEnabled, notificationsAllEnabled, connectorId, store] of rows) {
    it(label, () => {
      const r = decideNotificationRoute(pkg, { connectorEnabled, notificationsAllEnabled });
      expect(r.connector?.id ?? null).toBe(connectorId);
      expect(r.connectorId).toBe(connectorId);
      expect(r.store).toBe(store);
    });
  }

  it('classes: connector / im / app', () => {
    const on = { connectorEnabled: true, notificationsAllEnabled: true };
    expect(decideNotificationRoute(CAL, on).class).toBe('connector');
    expect(decideNotificationRoute(WHATSAPP, on).class).toBe('im');
    expect(decideNotificationRoute(WOLT, on).class).toBe('app');
  });

  it('a removal of a connector-package notification is stored (removed_at) but never parsed', () => {
    const r = decideNotificationRoute(CAL, { connectorEnabled: true, notificationsAllEnabled: true, removed: true });
    expect(r.connector).toBeNull();
    expect(r.connectorId).toBeNull();
    expect(r.store).toBe(true);
  });

  it('the notifications_all gate never blocks the connector path', () => {
    const r = decideNotificationRoute(CAL, { connectorEnabled: true, notificationsAllEnabled: false });
    expect(r.connector?.id).toBe('cal');
  });

  it('the stored doc carries connector_id only when handed to the parser', () => {
    const item: PushAppNotificationItem = {
      type: 'app_notification', package: CAL, title: 'Cal', text: 'חיוב 214 ש"ח', big_text: null,
      post_time: '2026-09-08T12:00:00+03:00', key: 'k1',
    };
    expect(buildNotificationDoc('u1', item, '2026-09-08T09:00:00.000Z', 'cal').connector_id).toBe('cal');
    expect(buildNotificationDoc('u1', item, '2026-09-08T09:00:00.000Z').connector_id).toBeNull();
  });
});

describe('connector capture device commands (pure)', () => {
  it('parses connector_<id> keys only', () => {
    expect(connectorIdFromSourceKey('connector_cal')).toBe('cal');
    expect(connectorIdFromSourceKey('gps')).toBeNull();
  });

  it('a connector toggle becomes update_data_source with the catalog packages', () => {
    const cmds = connectorCaptureCommands({ connector_isracard: { enabled: true }, gps: { enabled: false } });
    expect(cmds).toEqual([{
      source: 'connector_isracard',
      enabled: true,
      packages: ['com.isracard.hatavot', 'il.co.isracard.MobileDashboard'],
    }]);
  });

  it('disable carries enabled:false with the same packages', () => {
    const [cmd] = connectorCaptureCommands({ connector_cal: { enabled: false } });
    expect(cmd).toEqual({ source: 'connector_cal', enabled: false, packages: [CAL] });
  });

  it('skips unknown connectors, SMS-only connectors (no packages) and malformed values', () => {
    expect(connectorCaptureCommands({ connector_nope: { enabled: true } })).toEqual([]);
    expect(connectorCaptureCommands({ connector_water: { enabled: true } })).toEqual([]);
    expect(connectorCaptureCommands({ connector_financy: { enabled: true } })).toEqual([]);
    expect(connectorCaptureCommands({ connector_cal: {} })).toEqual([]);
    expect(connectorCaptureCommands(null)).toEqual([]);
  });
});

describe('GET /me/notification-capture seed (pure)', () => {
  it('lists every phone connector with packages when nothing is configured (gateway default = enabled)', () => {
    const seed = notificationCaptureSeed(null);
    const expected = CONNECTOR_CATALOG.filter((c) => (c.android_packages?.length ?? 0) > 0).map((c) => c.id);
    expect(Object.keys(seed.connector_packages).sort()).toEqual(expected.sort());
    expect(seed.connector_packages.cal).toEqual([CAL]);
    expect(seed.connector_packages.water).toBeUndefined();
  });

  it('drops explicitly disabled connectors and keeps explicitly enabled ones', () => {
    const seed = notificationCaptureSeed({ connector_cal: { enabled: false }, connector_max: { enabled: true } });
    expect(seed.connector_packages.cal).toBeUndefined();
    expect(seed.connector_packages.max).toEqual(['com.ideomobile.leumicard']);
  });

  it('always carries the IM packages', () => {
    const seed = notificationCaptureSeed({});
    expect(seed.im_packages).toEqual([...IM_PACKAGES]);
    expect(seed.im_packages).toContain(WHATSAPP);
  });
});
