import { describe, it, expect, vi } from 'vitest';
import { registerTrackedDeviceTools } from '../tools/tracked-devices.js';
import { captureTools, parseToolResponse } from './_helpers.js';
import type { TrackedDeviceRepository } from '../repositories/interfaces/tracked-device.repository.js';
import type { TrackedDevice } from '../types/tracked-device.js';

const USER_ID = 'user-test-1';
const getUserId = () => USER_ID;

function makeRepo(over: Partial<TrackedDeviceRepository> = {}): TrackedDeviceRepository {
  const unimpl = (name: string) => vi.fn(() => {
    throw new Error(`TrackedDeviceRepository.${name} not stubbed for this test`);
  });
  return {
    listAll: unimpl('listAll'),
    getByName: unimpl('getByName'),
    ...over,
  } as TrackedDeviceRepository;
}

function device(over: Partial<TrackedDevice> = {}): TrackedDevice {
  return {
    id: `${USER_ID}:dev-1`,
    userId: USER_ID,
    deviceId: 'dev-1',
    name: 'Car Keys',
    deviceType: 'tracker',
    location: { lat: 32.1, lon: 34.8 },
    lastSeen: new Date(Date.now() - 2 * 60_000).toISOString(), // 2 min ago
    ...over,
  };
}

describe('get_tracked_devices', () => {
  it('lists devices with a collapsed place + freshness', async () => {
    const repo = makeRepo({
      listAll: vi.fn(async () => [device({ matchedPlace: 'Home', batteryPct: 80 })]),
    });
    const tools = captureTools((s) => registerTrackedDeviceTools(s, repo, getUserId));

    const res = parseToolResponse<{ devices: Array<Record<string, unknown>>; total: number }>(
      await tools.get('get_tracked_devices')!({}),
    );

    expect(res.total).toBe(1);
    expect(res.devices[0].name).toBe('Car Keys');
    expect(res.devices[0].place).toBe('Home'); // matched place wins
    expect(res.devices[0].battery_pct).toBe(80);
    expect(res.devices[0].freshness).toBe('live');
    expect(res.devices[0].age_minutes).toBeLessThanOrEqual(3);
  });

  it('falls back through semantic → address → coords for place', async () => {
    const repo = makeRepo({
      listAll: vi.fn(async () => [
        device({ semanticName: 'Tel Aviv Mall' }),
        device({ deviceId: 'd2', address: '12 Some St' }),
        device({ deviceId: 'd3', location: { lat: 1.23456, lon: 2.34567 } }),
      ]),
    });
    const tools = captureTools((s) => registerTrackedDeviceTools(s, repo, getUserId));
    const res = parseToolResponse<{ devices: Array<{ place: string }> }>(
      await tools.get('get_tracked_devices')!({}),
    );
    expect(res.devices[0].place).toBe('Tel Aviv Mall');
    expect(res.devices[1].place).toBe('12 Some St');
    expect(res.devices[2].place).toBe('1.23456, 2.34567');
  });
});

describe('where_is_device', () => {
  it('returns found:false when no match', async () => {
    const repo = makeRepo({ getByName: vi.fn(async () => null) });
    const tools = captureTools((s) => registerTrackedDeviceTools(s, repo, getUserId));
    const res = parseToolResponse<{ found: boolean; query: string }>(
      await tools.get('where_is_device')!({ name: 'wallet' }),
    );
    expect(res.found).toBe(false);
    expect(res.query).toBe('wallet');
  });

  it('returns the matched device with stale freshness for an old fix', async () => {
    const old = new Date(Date.now() - 5 * 60 * 60_000).toISOString(); // 5h ago
    const repo = makeRepo({
      getByName: vi.fn(async () => device({ name: 'iPad', deviceType: 'tablet', lastSeen: old, matchedPlace: 'Office' })),
    });
    const tools = captureTools((s) => registerTrackedDeviceTools(s, repo, getUserId));
    const res = parseToolResponse<{ found: boolean; device: Record<string, unknown> }>(
      await tools.get('where_is_device')!({ name: 'ipad' }),
    );
    expect(res.found).toBe(true);
    expect(res.device.name).toBe('iPad');
    expect(res.device.place).toBe('Office');
    expect(res.device.freshness).toBe('unknown'); // >2h ⇒ unknown per computeFreshness
  });
});
