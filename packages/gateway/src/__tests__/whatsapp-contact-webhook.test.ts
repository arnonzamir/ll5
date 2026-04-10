import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processWhatsAppContactWebhook } from '../processors/whatsapp-contact-webhook.js';
import type { Pool } from 'pg';

function makePgPool(): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ id: 'contact-1' }] }),
  } as unknown as Pool;
}

describe('processWhatsAppContactWebhook', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = makePgPool();
  });

  it('upserts contacts with valid pushName', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501234567@s.whatsapp.net', pushName: 'Alice' },
    ]);

    const pgQuery = vi.mocked(pool.query);
    expect(pgQuery).toHaveBeenCalledTimes(1);
    const sql = pgQuery.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO messaging_contacts');
    const params = pgQuery.mock.calls[0][1] as unknown[];
    expect(params).toContain('972501234567@s.whatsapp.net');
    expect(params).toContain('Alice');
  });

  it('skips contacts with null pushName', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501234567@s.whatsapp.net', pushName: null },
    ]);

    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('skips contacts with empty pushName', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501234567@s.whatsapp.net', pushName: '' },
    ]);

    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('skips contacts where pushName equals phone number', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501234567@s.whatsapp.net', pushName: '972501234567' },
    ]);

    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('skips group JIDs', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '120363041234567890@g.us', pushName: 'My Group' },
    ]);

    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('handles @lid JIDs with null phone_number', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '12345678@lid', pushName: 'LidUser' },
    ]);

    const params = vi.mocked(pool.query).mock.calls[0][1] as unknown[];
    expect(params).toContain('12345678@lid');
    expect(params).toContain('LidUser');
    // phone_number should be null for @lid
    expect(params).toContain(null);
  });

  it('extracts phone number from @s.whatsapp.net JIDs', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501234567@s.whatsapp.net', pushName: 'Alice' },
    ]);

    const params = vi.mocked(pool.query).mock.calls[0][1] as unknown[];
    expect(params).toContain('+972501234567');
  });

  it('batches multiple contacts in a single query', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', [
      { remoteJid: '972501111111@s.whatsapp.net', pushName: 'Alice' },
      { remoteJid: '972502222222@s.whatsapp.net', pushName: 'Bob' },
      { remoteJid: '972503333333@s.whatsapp.net', pushName: 'Charlie' },
    ]);

    // Should be a single query with all three contacts
    expect(vi.mocked(pool.query)).toHaveBeenCalledTimes(1);
    const params = vi.mocked(pool.query).mock.calls[0][1] as unknown[];
    expect(params).toContain('Alice');
    expect(params).toContain('Bob');
    expect(params).toContain('Charlie');
  });

  it('handles empty contacts array', async () => {
    await processWhatsAppContactWebhook(pool, 'user-1', []);
    expect(vi.mocked(pool.query)).not.toHaveBeenCalled();
  });

  it('handles query errors gracefully', async () => {
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('DB error'));

    // Should not throw
    await expect(
      processWhatsAppContactWebhook(pool, 'user-1', [
        { remoteJid: '972501234567@s.whatsapp.net', pushName: 'Alice' },
      ]),
    ).resolves.toBeUndefined();
  });
});
