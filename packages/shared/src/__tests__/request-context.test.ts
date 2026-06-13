import { describe, it, expect } from 'vitest';
import {
  runWithRequestContext,
  getRequestContext,
  getContextUserId,
  getRequestId,
  getSessionId,
  getTraceId,
  newRequestId,
} from '../request-context.js';

describe('request-context', () => {
  it('exposes userId + a generated requestId inside the run', () => {
    runWithRequestContext({ userId: 'u-1' }, () => {
      expect(getContextUserId()).toBe('u-1');
      const rid = getRequestId();
      expect(rid).toMatch(/^req_[0-9a-f]{16}$/);
      expect(getSessionId()).toBeUndefined();
      expect(getTraceId()).toBeUndefined();
    });
  });

  it('returns undefined outside any context', () => {
    expect(getRequestContext()).toBeUndefined();
    expect(getContextUserId()).toBeUndefined();
    expect(getRequestId()).toBeUndefined();
  });

  it('honors an explicit requestId and propagates session/trace', () => {
    runWithRequestContext(
      { userId: 'u-2', requestId: 'req_fixed', sessionId: 's-9', traceId: 't-9' },
      () => {
        expect(getRequestId()).toBe('req_fixed');
        expect(getSessionId()).toBe('s-9');
        expect(getTraceId()).toBe('t-9');
      },
    );
  });

  it('isolates nested contexts and restores the outer one', () => {
    runWithRequestContext({ userId: 'outer' }, () => {
      const outerRid = getRequestId();
      runWithRequestContext({ userId: 'inner' }, () => {
        expect(getContextUserId()).toBe('inner');
        expect(getRequestId()).not.toBe(outerRid);
      });
      // back to outer after the nested run
      expect(getContextUserId()).toBe('outer');
      expect(getRequestId()).toBe(outerRid);
    });
  });

  it('propagates across awaits (async_hooks)', async () => {
    await runWithRequestContext({ userId: 'async-u' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getContextUserId()).toBe('async-u');
    });
  });

  it('newRequestId is unique-ish and well-formed', () => {
    const a = newRequestId();
    const b = newRequestId();
    expect(a).toMatch(/^req_[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
  });
});
