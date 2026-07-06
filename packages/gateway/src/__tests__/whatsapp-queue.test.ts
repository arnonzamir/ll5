import { describe, it, expect, vi } from 'vitest';
import { WhatsAppQueue, type QueuedEvent } from '../utils/whatsapp-queue.js';

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeMsg(obj: unknown) {
  return { content: Buffer.from(JSON.stringify(obj)) };
}
function mockChannel() {
  return { ack: vi.fn(), sendToQueue: vi.fn(), nack: vi.fn() };
}
/** Reach the private consumer internals for a focused unit test of onMessage. */
function wire(q: WhatsAppQueue, ch: ReturnType<typeof mockChannel>, handler: unknown) {
  (q as unknown as { conChannel: unknown }).conChannel = ch;
  (q as unknown as { handler: unknown }).handler = handler;
}
function onMessage(q: WhatsAppQueue, msg: unknown): Promise<void> {
  return (q as unknown as { onMessage(m: unknown): Promise<void> }).onMessage(msg);
}

const EVT: QueuedEvent = { userId: 'u1', payload: { event: 'messages.upsert' }, receivedAt: 't' };

describe('WhatsAppQueue.onMessage — retry/DLQ isolation', () => {
  it('acks on a successful handler and does not re-queue', async () => {
    const q = new WhatsAppQueue('amqp://x');
    const ch = mockChannel();
    const handler = vi.fn().mockResolvedValue(undefined);
    wire(q, ch, handler);
    const msg = makeMsg(EVT);
    await onMessage(q, msg);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(ch.ack).toHaveBeenCalledWith(msg);
    expect(ch.sendToQueue).not.toHaveBeenCalled();
  });

  it('routes to the retry queue (attempts incremented) on failure below the cap', async () => {
    const q = new WhatsAppQueue('amqp://x');
    const ch = mockChannel();
    wire(q, ch, vi.fn().mockRejectedValue(new Error('boom')));
    const msg = makeMsg({ ...EVT, attempts: 0 });
    await onMessage(q, msg);
    expect(ch.sendToQueue).toHaveBeenCalledWith('whatsapp.retry', expect.any(Buffer), expect.anything());
    const sent = JSON.parse((ch.sendToQueue.mock.calls[0][1] as Buffer).toString()) as QueuedEvent;
    expect(sent.attempts).toBe(1);
    expect(ch.ack).toHaveBeenCalledWith(msg); // original always acked (moved, not requeued in place)
  });

  it('parks in the DLQ once max attempts are exceeded, with the error', async () => {
    const q = new WhatsAppQueue('amqp://x');
    const ch = mockChannel();
    wire(q, ch, vi.fn().mockRejectedValue(new Error('boom')));
    const msg = makeMsg({ ...EVT, attempts: 5 }); // 5+1 = 6 > MAX_ATTEMPTS(5)
    await onMessage(q, msg);
    expect(ch.sendToQueue).toHaveBeenCalledWith('whatsapp.dlq', expect.any(Buffer), expect.anything());
    const parked = JSON.parse((ch.sendToQueue.mock.calls[0][1] as Buffer).toString()) as { error: string };
    expect(parked.error).toBe('boom');
    expect(ch.ack).toHaveBeenCalledWith(msg);
  });

  it('sends an undecodable message straight to the DLQ without invoking the handler', async () => {
    const q = new WhatsAppQueue('amqp://x');
    const ch = mockChannel();
    const handler = vi.fn();
    wire(q, ch, handler);
    const msg = { content: Buffer.from('not json {{{') };
    await onMessage(q, msg);
    expect(handler).not.toHaveBeenCalled();
    expect(ch.sendToQueue).toHaveBeenCalledWith('whatsapp.dlq', expect.anything(), expect.anything());
    expect(ch.ack).toHaveBeenCalledWith(msg);
  });
});

describe('WhatsAppQueue.publish — degradation (no loss)', () => {
  it('returns false when RABBITMQ_URL is unset (ingress processes inline)', async () => {
    const q = new WhatsAppQueue(undefined);
    expect(q.isEnabled()).toBe(false);
    expect(await q.publish(EVT)).toBe(false);
  });

  it('returns false when configured but not yet connected (broker down)', async () => {
    const q = new WhatsAppQueue('amqp://x');
    expect(q.isEnabled()).toBe(true);
    expect(await q.publish(EVT)).toBe(false); // pubChannel null → false, caller falls back inline
  });
});
