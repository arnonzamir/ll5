/** Chat attachment as clients render it (dashboard `metadata.attachments`). */
export interface ChatAttachment {
  type: 'image' | 'file';
  url: string;
  filename?: string;
  mime?: string;
}

export type AttachmentResult =
  | { ok: true; attachments: ChatAttachment[] | null }
  | { ok: false; error: string };

const MAX_ATTACHMENTS = 10;

/** `/uploads/x` and `/public/x` are what the upload route hands back; an absolute
 *  URL is allowed so the agent can attach something it fetched elsewhere. */
function isAcceptableUrl(url: string): boolean {
  if (url.startsWith('/uploads/') || url.startsWith('/public/')) return true;
  return /^https?:\/\//i.test(url);
}

/**
 * Validate the `attachments` an assistant-outbound message carries. Kept strict:
 * clients render these straight into the thread, so a malformed entry is a 400,
 * never a half-rendered bubble.
 */
export function normalizeAttachments(raw: unknown): AttachmentResult {
  if (raw == null) return { ok: true, attachments: null };
  if (!Array.isArray(raw)) return { ok: false, error: 'attachments must be an array' };
  if (raw.length === 0) return { ok: true, attachments: null };
  if (raw.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `attachments: at most ${MAX_ATTACHMENTS} per message` };
  }

  const out: ChatAttachment[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item == null) {
      return { ok: false, error: 'attachments: each entry must be an object' };
    }
    const { url, filename, mime, type } = item as Record<string, unknown>;

    if (typeof url !== 'string' || url.length === 0) {
      return { ok: false, error: 'attachments: url is required' };
    }
    if (!isAcceptableUrl(url)) {
      return { ok: false, error: `attachments: unsupported url "${url}" — use /uploads/…, /public/… or an absolute http(s) URL` };
    }
    if (filename != null && typeof filename !== 'string') {
      return { ok: false, error: 'attachments: filename must be a string' };
    }
    if (mime != null && typeof mime !== 'string') {
      return { ok: false, error: 'attachments: mime must be a string' };
    }
    if (type != null && type !== 'image' && type !== 'file') {
      return { ok: false, error: 'attachments: type must be "image" or "file"' };
    }

    const resolvedType: 'image' | 'file' =
      type === 'image' || type === 'file'
        ? type
        : typeof mime === 'string' && mime.startsWith('image/')
          ? 'image'
          : 'file';

    out.push({
      type: resolvedType,
      url,
      ...(typeof filename === 'string' ? { filename } : {}),
      ...(typeof mime === 'string' ? { mime } : {}),
    });
  }

  return { ok: true, attachments: out };
}
