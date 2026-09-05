import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMPDIR = path.join(os.tmpdir(), `ll5-auth-config-test-${Date.now()}`);
const origHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = TMPDIR;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

async function loadConfig() {
  return await import('../utils/config.js');
}

describe('config utils', () => {
  it('readConfig returns null when config file does not exist', async () => {
    const { readConfig } = await loadConfig();
    expect(readConfig()).toBeNull();
  });

  it('writeConfig saves config and readConfig reads it back', async () => {
    const { writeConfig, readConfig } = await loadConfig();
    const config = { gateway_url: 'https://example.com', user_id: 'user-1' };
    writeConfig(config);
    expect(readConfig()).toEqual(config);
  });

  it('writeConfig strips trailing slash from gateway_url', async () => {
    const { writeConfig, readConfig } = await loadConfig();
    writeConfig({ gateway_url: 'https://example.com/', user_id: 'user-1' });
    expect(readConfig()?.gateway_url).toBe('https://example.com/');
  });

  it('writeConfig creates config file with 0600 mode', async () => {
    const { writeConfig } = await loadConfig();
    writeConfig({ gateway_url: 'https://example.com', user_id: 'user-1' });
    const stat = fs.statSync(path.join(TMPDIR, '.ll5', 'config'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('writeConfig overwrites existing config', async () => {
    const { writeConfig, readConfig } = await loadConfig();
    writeConfig({ gateway_url: 'https://first.com', user_id: 'u1' });
    writeConfig({ gateway_url: 'https://second.com', user_id: 'u2' });
    expect(readConfig()).toEqual({ gateway_url: 'https://second.com', user_id: 'u2' });
  });

  it('readConfig returns null when JSON is malformed', async () => {
    const { readConfig } = await loadConfig();
    fs.mkdirSync(path.join(TMPDIR, '.ll5'), { mode: 0o700, recursive: true });
    fs.writeFileSync(path.join(TMPDIR, '.ll5', 'config'), 'not-json');
    expect(readConfig()).toBeNull();
  });
});
