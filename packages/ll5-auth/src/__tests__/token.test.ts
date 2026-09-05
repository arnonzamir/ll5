import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need a temp homedir so tests don't touch the real ~/.ll5
const TMPDIR = path.join(os.tmpdir(), `ll5-auth-test-${Date.now()}`);
const origHome = process.env.HOME;

beforeEach(() => {
  process.env.HOME = TMPDIR;
  fs.mkdirSync(path.join(TMPDIR, '.ll5'), { mode: 0o700, recursive: true });
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(TMPDIR, { recursive: true, force: true });
});

// Dynamic import after setting HOME
async function loadToken() {
  return await import('../utils/token.js');
}

describe('token utils', () => {
  it('readToken returns null when no token file exists', async () => {
    const { readToken } = await loadToken();
    expect(readToken()).toBeNull();
  });

  it('writeToken writes token and readToken reads it back', async () => {
    const { writeToken, readToken } = await loadToken();
    writeToken('ll5.eyJ1aWQiOiJ1c2VyLTEifQ.signature');
    expect(readToken()).toBe('ll5.eyJ1aWQiOiJ1c2VyLTEifQ.signature');
  });

  it('writeToken creates ~/.ll5 directory with 0700', async () => {
    const { writeToken } = await loadToken();
    writeToken('test-token');
    const stat = fs.statSync(path.join(TMPDIR, '.ll5'));
    // 0o700 = S_IRWXU
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('deleteToken returns true and removes the file', async () => {
    const { writeToken, deleteToken, readToken } = await loadToken();
    writeToken('test-token');
    expect(deleteToken()).toBe(true);
    expect(readToken()).toBeNull();
  });

  it('deleteToken returns false when no file exists', async () => {
    const { deleteToken } = await loadToken();
    expect(deleteToken()).toBe(false);
  });

  it('decodeTokenPayload returns null for non-ll5 tokens', async () => {
    const { decodeTokenPayload } = await loadToken();
    expect(decodeTokenPayload('not-an-ll5-token')).toBeNull();
  });

  it('decodeTokenPayload returns null for malformed tokens', async () => {
    const { decodeTokenPayload } = await loadToken();
    expect(decodeTokenPayload('ll5.not-valid-base64url.sig')).toBeNull();
  });

  it('decodeTokenPayload decodes a valid token payload', async () => {
    const { decodeTokenPayload } = await loadToken();
    const payload = Buffer.from(JSON.stringify({ uid: 'user-1', iat: 1000000, exp: 2000000 })).toString('base64url');
    const result = decodeTokenPayload(`ll5.${payload}.signature`);
    expect(result).toEqual({ uid: 'user-1', iat: 1000000, exp: 2000000 });
  });

  it('decodeTokenPayload returns null on truncated token with only 2 parts', async () => {
    const { decodeTokenPayload } = await loadToken();
    expect(decodeTokenPayload('ll5.partial')).toBeNull();
  });

  it('writeToken overwrites an existing token', async () => {
    const { writeToken, readToken } = await loadToken();
    writeToken('first-token');
    writeToken('second-token');
    expect(readToken()).toBe('second-token');
  });
});
