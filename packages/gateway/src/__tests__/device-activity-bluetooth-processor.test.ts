import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client } from '@elastic/elasticsearch';
import type { PushDeviceActivityItem, PushBluetoothItem } from '../types/index.js';
import { processDeviceActivity } from '../processors/device-activity.js';
import { processBluetooth } from '../processors/bluetooth.js';

const USER = 'user-act-1';

interface IndexCall {
  index: string;
  document: Record<string, unknown>;
}

function makeEs(): { es: Client; indexed: IndexCall[] } {
  const indexed: IndexCall[] = [];
  const es = {
    index: vi.fn(async (req: { index: string; document: Record<string, unknown> }) => {
      indexed.push({ index: req.index, document: req.document });
      return { result: 'created' };
    }),
  } as unknown as Client;
  return { es, indexed };
}

beforeEach(() => vi.clearAllMocks());

describe('processDeviceActivity', () => {
  it('stores a rollup with screen summary + top apps into the device-activity index', async () => {
    const { es, indexed } = makeEs();
    const item: PushDeviceActivityItem = {
      type: 'device_activity',
      timestamp: '2026-06-13T07:30:00.000Z',
      window_start: '2026-06-13T07:15:00.000Z',
      window_end: '2026-06-13T07:30:00.000Z',
      screen_on_ms: 600000,
      unlock_count: 3,
      first_interaction: '2026-06-13T07:18:00.000Z',
      last_interaction: '2026-06-13T07:29:00.000Z',
      interactive_now: true,
      top_apps: [
        { package: 'com.google.maps', app_name: 'Maps', category: 'maps', foreground_ms: 240000, opens: 1 },
        { package: 'com.slack', app_name: 'Slack', category: 'productivity', foreground_ms: 120000, opens: 2 },
      ],
    };

    await processDeviceActivity(es, USER, item);

    expect(indexed).toHaveLength(1);
    const { index, document } = indexed[0]!;
    expect(index).toBe('ll5_awareness_device_activity');
    expect(document.user_id).toBe(USER);
    expect(document.screen_on_ms).toBe(600000);
    expect(document.unlock_count).toBe(3);
    expect(document.first_interaction).toBe('2026-06-13T07:18:00.000Z');
    expect(document.interactive_now).toBe(true);
    expect(Array.isArray(document.top_apps)).toBe(true);
    expect((document.top_apps as unknown[]).length).toBe(2);
    expect((document.top_apps as Record<string, unknown>[])[0]!.app_name).toBe('Maps');
  });

  it('omits absent optional fields', async () => {
    const { es, indexed } = makeEs();
    await processDeviceActivity(es, USER, {
      type: 'device_activity',
      timestamp: '2026-06-13T08:00:00.000Z',
      window_start: '2026-06-13T07:45:00.000Z',
      window_end: '2026-06-13T08:00:00.000Z',
    });
    const { document } = indexed[0]!;
    expect(document).not.toHaveProperty('screen_on_ms');
    expect(document).not.toHaveProperty('top_apps');
    expect(document.window_end).toBe('2026-06-13T08:00:00.000Z');
  });
});

describe('processBluetooth', () => {
  it('stores a connect event with device class into the bluetooth index', async () => {
    const { es, indexed } = makeEs();
    const item: PushBluetoothItem = {
      type: 'bluetooth',
      timestamp: '2026-06-13T08:05:00.000Z',
      connected: true,
      device_name: "Arnon's Car",
      device_address: 'AA:BB:CC:DD:EE:FF',
      device_class: 'car',
    };

    await processBluetooth(es, USER, item);

    expect(indexed).toHaveLength(1);
    const { index, document } = indexed[0]!;
    expect(index).toBe('ll5_awareness_bluetooth');
    expect(document.user_id).toBe(USER);
    expect(document.connected).toBe(true);
    expect(document.device_class).toBe('car');
    expect(document.device_name).toBe("Arnon's Car");
  });
});
