import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

/**
 * Quiet-hours release (DECISION-030). Every few minutes: for each user with
 * held proactive pushes whose release_at has passed, deliver ONE digest chat
 * message (with a normal `notify` phone push) and mark the rows released.
 * Delivery is injected so the scheduler stays free of the chat internals.
 */
export interface HeldRow { id: string; content: string; notification_level: string | null; reason: string; created_at: Date }

export type Deliver = (userId: string, text: string, level: 'silent' | 'notify' | 'alert' | 'critical') => Promise<void>;

/** Pure: build the digest text. Short items stay whole; long ones are trimmed to their first line. */
export function buildDigest(rows: HeldRow[], tz: string): string {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d);
  const items = rows.map((r) => {
    const first = r.content.trim().split('\n')[0];
    const body = first.length > 160 ? first.slice(0, 157) + '…' : first;
    return `- ${time(r.created_at)} ${body}`;
  });
  return `Held overnight (${rows.length}):\n${items.join('\n')}`;
}

export class QuietHoursReleaseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private pool: Pool, private deliver: Deliver, private config: { intervalMinutes: number; timezone: string; userId: string }) {}

  start(): void {
    logger.info('[QuietHoursRelease][start] Started', { userId: this.config.userId, intervalMinutes: this.config.intervalMinutes });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
  }
  stop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  async releaseDue(now = new Date()): Promise<number> {
    const due = await this.pool.query<HeldRow>(
      `SELECT id, content, notification_level, reason, created_at FROM held_messages
        WHERE user_id = $1 AND released_at IS NULL AND release_at <= $2
        ORDER BY created_at ASC`,
      [this.config.userId, now],
    );
    if (due.rows.length === 0) return 0;
    const text = buildDigest(due.rows, this.config.timezone);
    await this.deliver(this.config.userId, text, 'notify');
    await this.pool.query(`UPDATE held_messages SET released_at = now() WHERE id = ANY($1::uuid[])`, [due.rows.map((r) => r.id)]);
    logger.info('[QuietHoursRelease][tick] released digest', { userId: this.config.userId, count: due.rows.length });
    return due.rows.length;
  }

  private async tick(): Promise<void> {
    try { await withSchedulerHealth('quiet_hours_release', () => this.releaseDue().then(() => undefined)); } catch { /* recorded by withSchedulerHealth */ }
  }
}
