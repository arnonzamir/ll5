import { describe, it, expect } from 'vitest';
import { OtpStore, OTP_TTL_MS } from '../otp.js';

describe('OtpStore (60 s TTL, in memory)', () => {
  it('stores a well-formed code and hands it to the next take within the TTL', () => {
    let t = 1_000_000;
    const s = new OtpStore(() => t);
    expect(s.submit('u1', 'bank', ' 123456 ')).toEqual({ accepted: true, waiting_pull: false });
    t += OTP_TTL_MS - 1;
    expect(s.take('u1', 'bank')).toBe('123456');
    expect(s.take('u1', 'bank')).toBeNull(); // single use
  });

  it('expires after 60 s', () => {
    let t = 0;
    const s = new OtpStore(() => t);
    s.submit('u1', 'bank', '4321');
    t = OTP_TTL_MS + 1;
    expect(s.take('u1', 'bank')).toBeNull();
  });

  it('refuses a malformed code and keeps codes per user + connector', () => {
    const s = new OtpStore(() => 0);
    expect(s.submit('u1', 'bank', 'abc')).toEqual({ accepted: false, waiting_pull: false });
    expect(s.submit('u1', 'bank', '12')).toEqual({ accepted: false, waiting_pull: false });
    s.submit('u1', 'bank', '1111');
    expect(s.take('u2', 'bank')).toBeNull();
    expect(s.take('u1', 'cal')).toBeNull();
    expect(s.take('u1', 'bank')).toBe('1111');
  });

  it('resolves a waiting pull directly and reports waiting_pull: true', async () => {
    const s = new OtpStore();
    const waiting = s.waitFor('u1', 'bank', 5_000);
    expect(s.isWaiting('u1', 'bank')).toBe(true);
    expect(s.submit('u1', 'bank', '987654')).toEqual({ accepted: true, waiting_pull: true });
    expect(await waiting).toBe('987654');
    expect(s.isWaiting('u1', 'bank')).toBe(false);
  });

  it('a waiting pull times out with null', async () => {
    const s = new OtpStore();
    expect(await s.waitFor('u1', 'bank', 10)).toBeNull();
  });
});
