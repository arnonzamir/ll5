import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const LL5_DIR = path.join(os.homedir(), '.ll5');
const TOKEN_PATH = path.join(LL5_DIR, 'token');

function ensureDir(): void {
  if (!fs.existsSync(LL5_DIR)) {
    fs.mkdirSync(LL5_DIR, { mode: 0o700, recursive: true });
  }
}

export function readToken(): string | null {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf-8').trim();
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  ensureDir();
  fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 });
}

export function deleteToken(): boolean {
  try {
    fs.unlinkSync(TOKEN_PATH);
    return true;
  } catch {
    return false;
  }
}

export interface DecodedPayload {
  uid: string;
  iat: number;
  exp: number;
}

export function decodeTokenPayload(token: string): DecodedPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'll5') return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString();
    return JSON.parse(json) as DecodedPayload;
  } catch {
    return null;
  }
}
