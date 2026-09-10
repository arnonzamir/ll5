import { describe, it, expect } from 'vitest';
import { normalizeAttachments } from '../utils/attachments.js';

describe('normalizeAttachments', () => {
  it('treats absent/empty as no attachments', () => {
    expect(normalizeAttachments(undefined)).toEqual({ ok: true, attachments: null });
    expect(normalizeAttachments(null)).toEqual({ ok: true, attachments: null });
    expect(normalizeAttachments([])).toEqual({ ok: true, attachments: null });
  });

  it('derives type from mime when not given', () => {
    const r = normalizeAttachments([
      { url: '/uploads/a.png', mime: 'image/png' },
      { url: '/uploads/b.pdf', mime: 'application/pdf', filename: 'report.pdf' },
      { url: '/uploads/c.bin' },
    ]);
    expect(r).toEqual({
      ok: true,
      attachments: [
        { type: 'image', url: '/uploads/a.png', mime: 'image/png' },
        { type: 'file', url: '/uploads/b.pdf', filename: 'report.pdf', mime: 'application/pdf' },
        { type: 'file', url: '/uploads/c.bin' },
      ],
    });
  });

  it('honours an explicit type over the mime guess', () => {
    const r = normalizeAttachments([{ url: '/uploads/a.png', mime: 'image/png', type: 'file' }]);
    expect(r).toMatchObject({ ok: true, attachments: [{ type: 'file' }] });
  });

  it('accepts /public and absolute urls', () => {
    expect(normalizeAttachments([{ url: '/public/x.jpg' }]).ok).toBe(true);
    expect(normalizeAttachments([{ url: 'https://example.com/x.jpg' }]).ok).toBe(true);
  });

  it('rejects malformed entries', () => {
    expect(normalizeAttachments('nope')).toMatchObject({ ok: false });
    expect(normalizeAttachments([{ filename: 'no-url.pdf' }])).toMatchObject({ ok: false });
    expect(normalizeAttachments([{ url: 'ftp://example.com/x' }])).toMatchObject({ ok: false });
    expect(normalizeAttachments([{ url: '/etc/passwd' }])).toMatchObject({ ok: false });
    expect(normalizeAttachments([{ url: '/uploads/a', type: 'video' }])).toMatchObject({ ok: false });
    expect(normalizeAttachments([{ url: '/uploads/a', mime: 5 }])).toMatchObject({ ok: false });
  });

  it('caps the count at 10', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ url: `/uploads/${i}.png` }));
    expect(normalizeAttachments(many)).toMatchObject({ ok: false });
  });
});
