import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initAudit, logToolCall, logAudit } from '../audit.js';
import { runWithRequestContext } from '../request-context.js';

describe('audit tool-ledger (DECISION-012 stage 3)', () => {
  let bodies: any[];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true } as Response;
    }));
    initAudit('http://es:9200');
  });

  it('writes a kind=tool_call row with full args/result + correlation ids', () => {
    runWithRequestContext({ userId: 'u-1', requestId: 'req_abc', sessionId: 's-1', traceId: 't-1' }, () => {
      logToolCall({
        tool_name: 'get_situation',
        args: { window: '2h' },
        result: { content: [{ type: 'text', text: 'ok' }] },
        duration_ms: 42,
        success: true,
      });
    });
    expect(bodies).toHaveLength(1);
    const d = bodies[0];
    expect(d.kind).toBe('tool_call');
    expect(d.tool_name).toBe('get_situation');
    // args/result are stored as JSON strings (parse to recover).
    expect(JSON.parse(d.args)).toEqual({ window: '2h' });
    expect(JSON.parse(d.result)).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(d.success).toBe(true);
    expect(d.duration_ms).toBe(42);
    // correlation pulled from the request context
    expect(d.user_id).toBe('u-1');
    expect(d.request_id).toBe('req_abc');
    expect(d.session_id).toBe('s-1');
    expect(d.trace_id).toBe('t-1');
    expect(typeof d.timestamp).toBe('string');
  });

  it('records failures with success=false + error_message and no result', () => {
    runWithRequestContext({ userId: 'u-2' }, () => {
      logToolCall({ tool_name: 'boom', args: { x: 1 }, success: false, error_message: 'kaboom' });
    });
    const d = bodies[0];
    expect(d.success).toBe(false);
    expect(d.error_message).toBe('kaboom');
    expect(d.result).toBeNull();
    expect(d.request_id).toMatch(/^req_/); // generated
  });

  it('logAudit still writes kind=mutation rows', () => {
    runWithRequestContext({ userId: 'u-3', requestId: 'req_m' }, () => {
      logAudit({ user_id: 'u-3', source: 'gtd', action: 'delete', entity_type: 'action', entity_id: 'a1', summary: 'deleted' });
    });
    const d = bodies[0];
    expect(d.kind).toBe('mutation');
    expect(d.entity_id).toBe('a1');
    expect(d.request_id).toBe('req_m');
  });
});
