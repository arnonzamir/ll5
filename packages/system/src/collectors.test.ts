import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatBytes, getSystem } from './collectors.js';

describe('formatBytes', () => {
  it('returns "0 B" for 0', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats KB', () => {
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
  });

  it('formats MB', () => {
    expect(formatBytes(1048576)).toBe('1 MB');
    expect(formatBytes(3145728)).toBe('3 MB');
  });

  it('formats GB', () => {
    expect(formatBytes(1073741824)).toBe('1 GB');
    expect(formatBytes(5368709120)).toBe('5 GB');
  });

  it('formats TB', () => {
    expect(formatBytes(1099511627776)).toBe('1 TB');
  });

  it('rounds to 2 decimal places', () => {
    expect(formatBytes(1024 * 1.234)).toBe('1.23 KB');
  });
});

describe('getSystem', () => {
  it('returns system info with all required fields', () => {
    const info = getSystem();
    expect(info).toHaveProperty('hostname');
    expect(info).toHaveProperty('platform');
    expect(info).toHaveProperty('release');
    expect(info).toHaveProperty('uptimeSeconds');
    expect(typeof info.hostname).toBe('string');
    expect(typeof info.platform).toBe('string');
    expect(typeof info.release).toBe('string');
    expect(typeof info.uptimeSeconds).toBe('number');
    expect(info.uptimeSeconds).toBeGreaterThan(0);
  });
});
