import { describe, it, expect, vi, beforeEach } from 'vitest';
import { processPhoneContacts } from '../processors/phone-contacts.js';
import type { Pool, QueryResult } from 'pg';

function makePgPool(rowCount = 0): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount }),
  } as unknown as Pool;
}

describe('processPhoneContacts', () => {
  let pool: Pool;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = makePgPool(1);
  });

  it('enriches contacts matching phone number JID patterns', async () => {
    const contacts = [
      { sender: 'Ori Schnitzer', body: '+972-54-458-9555' },
    ];

    const enriched = await processPhoneContacts(pool, 'user-1', contacts);
    expect(enriched).toBe(1);

    const query = vi.mocked(pool.query);
    expect(query).toHaveBeenCalledTimes(1);

    // Check that JID patterns include the normalized variants
    const args = query.mock.calls[0][1] as unknown[];
    const jidPatterns = args[3] as string[];
    expect(jidPatterns).toContain('972544589555@s.whatsapp.net');
    expect(jidPatterns).toContain('972544589555@lid');
  });

  it('generates Israeli country code variants for local numbers', async () => {
    const contacts = [
      { sender: 'Local Person', body: '054-458-9555' },
    ];

    await processPhoneContacts(pool, 'user-1', contacts);

    const query = vi.mocked(pool.query);
    const args = query.mock.calls[0][1] as unknown[];
    const jidPatterns = args[3] as string[];

    // Should have both local digits (with leading 0) and 972 variant
    expect(jidPatterns).toContain('0544589555@s.whatsapp.net');  // local format
    expect(jidPatterns).toContain('972544589555@s.whatsapp.net'); // 972 prefix variant
  });

  it('generates local variant for numbers with country code', async () => {
    const contacts = [
      { sender: 'International', body: '+972544589555' },
    ];

    await processPhoneContacts(pool, 'user-1', contacts);

    const query = vi.mocked(pool.query);
    const args = query.mock.calls[0][1] as unknown[];
    const jidPatterns = args[3] as string[];

    expect(jidPatterns).toContain('972544589555@s.whatsapp.net');
    expect(jidPatterns).toContain('0544589555@s.whatsapp.net'); // local 0-prefix variant
  });

  it('skips contacts with empty name or phone', async () => {
    const contacts = [
      { sender: '', body: '+972544589555' },
      { sender: 'Name', body: '' },
    ];

    const enriched = await processPhoneContacts(pool, 'user-1', contacts);
    expect(enriched).toBe(0);
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('passes display name and phone number to the update', async () => {
    const contacts = [
      { sender: 'Test User', body: '+972544589555' },
    ];

    await processPhoneContacts(pool, 'user-1', contacts);

    const query = vi.mocked(pool.query);
    const args = query.mock.calls[0][1] as unknown[];
    expect(args[0]).toBe('Test User');          // display_name
    expect(args[1]).toBe('+972544589555');       // phone_number (original)
    expect(args[2]).toBe('user-1');              // user_id
  });

  it('returns 0 when no rows are updated', async () => {
    pool = makePgPool(0);
    const contacts = [
      { sender: 'Nobody', body: '+1234567890' },
    ];

    const enriched = await processPhoneContacts(pool, 'user-1', contacts);
    expect(enriched).toBe(0);
  });

  it('continues processing after individual contact errors', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('db error'))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    pool = { query } as unknown as Pool;

    const contacts = [
      { sender: 'Fail', body: '+1111111111' },
      { sender: 'Success', body: '+2222222222' },
    ];

    const enriched = await processPhoneContacts(pool, 'user-1', contacts);
    expect(enriched).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
  });
});
