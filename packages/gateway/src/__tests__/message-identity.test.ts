import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { parseMessageAuthor, enrichContact, buildSourceRouting } from '../processors/message-identity.js';

describe('parseMessageAuthor', () => {
  describe('slack', () => {
    it('strips the redundant "#channel: " prefix to get the author', () => {
      const r = parseMessageAuthor('slack', '#data-platform-alerts: Opsgenie (bot)', '#data-platform-alerts', true);
      expect(r.authorName).toBe('Opsgenie');
      expect(r.authorId).toBe('Opsgenie');
      expect(r.isBot).toBe(true);
    });

    it('strips a non-# channel prefix that matches group_name', () => {
      const r = parseMessageAuthor('slack', 'data_engineering_on-call: airflow_slack_bot (bot)', 'data_engineering_on-call', true);
      expect(r.authorName).toBe('airflow_slack_bot');
      expect(r.isBot).toBe(true);
    });

    it('keeps a human author and is not flagged as bot', () => {
      const r = parseMessageAuthor('slack', '#eng-sync: Dana Cohen', '#eng-sync', true);
      expect(r.authorName).toBe('Dana Cohen');
      expect(r.isBot).toBe(false);
    });

    it('leaves the sender intact when there is no channel prefix', () => {
      const r = parseMessageAuthor('slack', 'Dana Cohen', null, false);
      expect(r.authorName).toBe('Dana Cohen');
    });
  });

  describe('sms', () => {
    it('captures a normalized phone number from a bare number sender', () => {
      const r = parseMessageAuthor('sms', '+15550001111', null, false);
      expect(r.authorName).toBe('+15550001111');
      expect(r.phoneNumber).toBe('+15550001111');
    });

    it('treats an alphanumeric short-code as a plain name (no phone number)', () => {
      const r = parseMessageAuthor('sms', 'Leumi', null, false);
      expect(r.authorName).toBe('Leumi');
      expect(r.phoneNumber).toBeNull();
    });
  });

  describe('gmail / default', () => {
    it('passes the email author display name through unchanged', () => {
      const r = parseMessageAuthor('gmail', 'Rafi Daskalo', 'arnon.zamir@sunbit.com', true);
      expect(r.authorName).toBe('Rafi Daskalo');
      expect(r.isBot).toBe(false);
    });
  });
});

describe('enrichContact', () => {
  function makePool(rows: unknown[] = []): Pool {
    return { query: vi.fn().mockResolvedValue({ rows }) } as unknown as Pool;
  }

  it('upserts into messaging_contacts with the platform-keyed args and returns the link', async () => {
    const pool = makePool([{ person_id: 'p-1', display_name: 'Mom' }]);
    const res = await enrichContact(pool, 'user-1', 'sms', '+15550001111', '+15550001111', {
      phoneNumber: '+15550001111',
      isGroup: false,
    });
    expect(res).toEqual({ personId: 'p-1', displayName: 'Mom' });

    const call = vi.mocked(pool.query).mock.calls[0];
    expect(call[0] as string).toContain('INSERT INTO messaging_contacts');
    // Param order: [userId, platformId, displayName, phoneNumber, isGroup, platform]
    const args = call[1] as unknown[];
    expect(args[1]).toBe('+15550001111'); // platform_id
    expect(args[2]).toBe('+15550001111'); // display_name
    expect(args[5]).toBe('sms');          // platform
  });

  it('falls back to the given display name and null person on DB failure', async () => {
    const pool = { query: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as Pool;
    const res = await enrichContact(pool, 'user-1', 'slack', 'Opsgenie', 'Opsgenie');
    expect(res).toEqual({ personId: null, displayName: 'Opsgenie' });
  });
});

describe('buildSourceRouting', () => {
  it('builds a SourceRoutingMeta and omits empty contact_name/person_id', () => {
    const sr = buildSourceRouting({
      platform: 'slack',
      remoteJid: 'slack:group:#eng-sync',
      senderName: 'Dana',
      contactName: '',
      personId: null,
      fromMe: false,
      isGroup: true,
      groupName: '#eng-sync',
    });
    expect(sr).toEqual({
      platform: 'slack',
      remote_jid: 'slack:group:#eng-sync',
      sender_name: 'Dana',
      contact_name: undefined,
      person_id: undefined,
      from_me: false,
      is_group: true,
      group_name: '#eng-sync',
    });
  });
});
