import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import { releaseHeldInitialPushes } from '../delivery.js';
import type { DeliveryBlock, DeliveryClass } from '../utils/delivery-contract.js';

/**
 * Quiet-hours release (DECISION-030, digest shape per DECISION-034). Every
 * few minutes: for each user with held proactive pushes whose release_at has
 * passed, deliver ONE digest chat message (with a normal `notify` phone push),
 * mark the rows released, then re-push each still-open ask individually at
 * its mapped level: held needs-you rows become real classed messages (chat
 * row + tray ask + push), and do-by rows whose initial push the hold withheld
 * get that push now. Delivery is injected so the scheduler stays free of the
 * chat internals.
 */
export interface HeldRow {
  id: string;
  content: string;
  notification_level: string | null;
  reason: string;
  created_at: Date;
  display_compact?: boolean;
  metadata?: Record<string, unknown> | null;
}

export interface DigestRow {
  content: string;
  created_at: Date;
  class?: DeliveryClass | null;
  subject?: string | null;
}

export type Deliver = (
  userId: string,
  text: string,
  level: 'silent' | 'notify' | 'alert' | 'critical',
  metadata: Record<string, unknown>,
) => Promise<void>;

/** Turn a held needs-you into a live classed message (chat row + tray ask + push). */
export type Materialize = (userId: string, row: HeldRow, delivery: DeliveryBlock) => Promise<void>;

/** The delivery block a held row carried (POST /chat/messages stores it in metadata.delivery). */
export function heldDelivery(row: HeldRow): DeliveryBlock | null {
  const d = row.metadata?.delivery as DeliveryBlock | undefined;
  return d && typeof d === 'object' && typeof d.class === 'string' ? d : null;
}

const ASK_CLASSES: readonly DeliveryClass[] = ['do-by', 'needs-you'];

/**
 * Pure: build the digest text. No per-item trim — each line is
 * `HH:MM · class · subject — first line` (subject omitted for fyi); open asks
 * lead (do-by before needs-you, then by time), fyi follow in time order.
 */
export function buildDigest(rows: DigestRow[], tz: string): string {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const rank = (r: DigestRow) => { const i = ASK_CLASSES.indexOf(r.class ?? 'fyi'); return i === -1 ? ASK_CLASSES.length : i; };
  const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.created_at.getTime() - b.created_at.getTime());
  const items = ordered.map((r) => {
    const first = r.content.replace(/\r/g, '').trim().split('\n')[0] ?? '';
    const cls = r.class ?? 'fyi';
    return r.subject && cls !== 'fyi'
      ? `- ${time(r.created_at)} · ${cls} · ${r.subject} — ${first}`
      : `- ${time(r.created_at)} · ${cls} · ${first}`;
  });
  return `Held overnight (${rows.length}):\n${items.join('\n')}`;
}

export class QuietHoursReleaseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private pool: Pool,
    private deliver: Deliver,
    private config: { intervalMinutes: number; timezone: string; userId: string },
    private materialize?: Materialize,
  ) {}

  start(): void {
    logger.info('[QuietHoursRelease][start] Started', { userId: this.config.userId, intervalMinutes: this.config.intervalMinutes });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  /** do-by rows whose initial push is still held — they lead the digest. */
  private async heldDoBys(now: Date): Promise<DigestRow[]> {
    try {
      const r = await this.pool.query<{ subject: string | null; content: string | null; created_at: Date }>(
        `SELECT d.subject, m.content, d.created_at
           FROM message_delivery d LEFT JOIN chat_messages m ON m.id = d.message_id
          WHERE d.user_id = $1 AND d.status = 'sent' AND d.class = 'do-by'
            AND d.escalation->>'initial_push' = 'held'
            AND (d.escalation->>'ladder_start')::timestamptz <= $2`,
        [this.config.userId, now.toISOString()],
      );
      return r.rows.map((x) => ({ class: 'do-by' as const, subject: x.subject, content: x.content ?? x.subject ?? '', created_at: new Date(x.created_at) }));
    } catch (err) {
      if ((err as { code?: string } | null)?.code === '42P01') return [];
      throw err;
    }
  }

  async releaseDue(now = new Date()): Promise<number> {
    const due = await this.pool.query<HeldRow>(
      `SELECT id, content, notification_level, reason, created_at, display_compact, metadata FROM held_messages
        WHERE user_id = $1 AND released_at IS NULL AND release_at <= $2
        ORDER BY created_at ASC`,
      [this.config.userId, now],
    );
    const doBys = await this.heldDoBys(now);
    if (due.rows.length === 0 && doBys.length === 0) return 0;

    const digestRows: DigestRow[] = [
      ...doBys,
      ...due.rows.map((r) => {
        const d = heldDelivery(r);
        return { content: r.content, created_at: new Date(r.created_at), class: d?.class ?? null, subject: d?.subject ?? null };
      }),
    ];
    const text = buildDigest(digestRows, this.config.timezone);
    await this.deliver(this.config.userId, text, 'notify', {
      kind: 'quiet_hours_digest', class: 'fyi', digest_of: due.rows.map((r) => r.id),
    });
    if (due.rows.length > 0) {
      await this.pool.query(`UPDATE held_messages SET released_at = now() WHERE id = ANY($1::uuid[])`, [due.rows.map((r) => r.id)]);
    }

    // Section 8 answer 3: open asks are also re-pushed individually.
    let asks = 0;
    for (const r of due.rows) {
      const d = heldDelivery(r);
      if (!d || d.class === 'fyi' || !this.materialize) continue;
      if (d.due_at && Date.parse(d.due_at) <= now.getTime()) {
        logger.info('[QuietHoursRelease][tick] held ask already past due — digest line only', { userId: this.config.userId, held_id: r.id, subject: d.subject });
        continue;
      }
      try {
        await this.materialize(this.config.userId, r, d);
        asks += 1;
      } catch (err) {
        logger.error('[QuietHoursRelease][tick] failed to materialise held ask', { held_id: r.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    asks += await releaseHeldInitialPushes(this.pool, this.config.userId, now);

    logger.info('[QuietHoursRelease][tick] released digest', { userId: this.config.userId, count: due.rows.length, asks_repushed: asks });
    return due.rows.length + doBys.length;
  }

  private async tick(): Promise<void> {
    try { await withSchedulerHealth('quiet_hours_release', () => this.releaseDue().then(() => undefined)); } catch { /* recorded by withSchedulerHealth */ }
  }
}
