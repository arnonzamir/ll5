import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LL5_DIR = path.join(os.homedir(), '.ll5');
const CONFIG_PATH = path.join(LL5_DIR, 'config');

export interface Ll5Config {
  gateway_url: string;
  user_id: string;
}

function ensureDir(): void {
  if (!fs.existsSync(LL5_DIR)) {
    fs.mkdirSync(LL5_DIR, { mode: 0o700, recursive: true });
  }
}

export function readConfig(): Ll5Config | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as Ll5Config;
  } catch {
    return null;
  }
}

export function writeConfig(config: Ll5Config): void {
  ensureDir();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
}
