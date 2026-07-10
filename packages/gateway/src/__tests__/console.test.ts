import { describe, it, expect } from 'vitest';
import { signConsoleToken, verifyConsoleToken, uidFromConsoleHost } from '../console.js';

const SECRET = 'test-secret-key-at-least-32-characters-long!!';
const UID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

describe('console token', () => {
  it('round-trips a valid token bound to the uid', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    expect(verifyConsoleToken(tok, SECRET, 1001)).toEqual({ uid: UID });
  });

  it('rejects an expired token', () => {
    const tok = signConsoleToken(UID, SECRET, 60, 1000);
    expect(verifyConsoleToken(tok, SECRET, 1000 + 61)).toBeNull();
  });

  it('rejects a tampered payload / bad signature', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    const forged = tok.slice(0, -1) + (tok.endsWith('a') ? 'b' : 'a');
    expect(verifyConsoleToken(forged, SECRET, 1001)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const tok = signConsoleToken(UID, SECRET, 3600, 1000);
    expect(verifyConsoleToken(tok, 'another-secret-key-at-least-32-characters', 1001)).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(verifyConsoleToken(undefined, SECRET)).toBeNull();
    expect(verifyConsoleToken('', SECRET)).toBeNull();
    expect(verifyConsoleToken('c1.only-two', SECRET)).toBeNull();
    expect(verifyConsoleToken('x9.a.b', SECRET)).toBeNull();
  });
});

describe('uidFromConsoleHost', () => {
  it('extracts the uuid from agent-<uid>.<base>', () => {
    expect(uidFromConsoleHost(`agent-${UID}.noninoni.click`)).toBe(UID);
  });
  it('returns null for non-console hosts', () => {
    expect(uidFromConsoleHost('ll5.noninoni.click')).toBeNull();
    expect(uidFromConsoleHost(undefined)).toBeNull();
    expect(uidFromConsoleHost('agent-.noninoni.click')).toBeNull();
  });
});
