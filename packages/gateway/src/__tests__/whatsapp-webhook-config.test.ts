import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ensureWhatsAppWebhook, DESIRED_EVENTS } from '../processors/whatsapp-webhook-config.js';

const TARGET = {
  evolutionApiUrl: 'https://evo.example',
  apiKey: 'GLOBALKEY',
  instance: 'll5',
  webhookUrl: 'https://gateway.example/webhook/whatsapp',
  webhookSecret: 'S3CR3T',
};

function findResponse(state: unknown): Response {
  return { ok: true, status: 200, json: async () => state } as unknown as Response;
}

describe('ensureWhatsAppWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs a corrected config when base64 is true (the 413 jam cause)', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/webhook/find/')) {
        return findResponse({
          enabled: true,
          url: TARGET.webhookUrl,
          webhookBase64: true, // <-- drift: must be corrected
          headers: { 'X-Webhook-Secret': TARGET.webhookSecret },
          events: [...DESIRED_EVENTS],
        });
      }
      // set
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body));
      expect(body.webhook.base64).toBe(false);
      expect(body.webhook.headers['X-Webhook-Secret']).toBe(TARGET.webhookSecret);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const changed = await ensureWhatsAppWebhook(TARGET);
    expect(changed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2); // find + set
  });

  it('is a no-op when the config already matches (idempotent)', async () => {
    const fetchMock = vi.fn(async () =>
      findResponse({
        enabled: true,
        url: TARGET.webhookUrl,
        webhookBase64: false,
        headers: { 'X-Webhook-Secret': TARGET.webhookSecret },
        events: [...DESIRED_EVENTS],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const changed = await ensureWhatsAppWebhook(TARGET);
    expect(changed).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // find only, no set
  });

  it('sets a fresh webhook when none exists (404 on find)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/webhook/find/')) {
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      }
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const changed = await ensureWhatsAppWebhook(TARGET);
    expect(changed).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never throws on network error — returns false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
    const changed = await ensureWhatsAppWebhook(TARGET);
    expect(changed).toBe(false);
  });
});
