import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface WakeSchedulerConfig {
  userId: string;
  timezone: string;
}

const INDEX = 'll5_scheduled_wakes';
// Recurring wakes only fire if the local clock is within this many minutes PAST
// the target — so a wake missed by a long outage (or created hours later) does
// not fire a stale escalation at the wrong time of day. It catches a brief gap,
// not a half-day one.
const RECURRING_CATCHUP_MIN = 90;
// A one-off missed by more than this is expired silently (no stale surprise),
// not fired — but the window is generous so a normal restart still delivers it.
const ONEOFF_CATCHUP_HOURS = 6;

interface WakeDoc {
  user_id: string;
  kind?: string;
  payload?: string;
  recurrence?: string;
  fire_at?: string | null;
  fire_local?: string | null;
  tz?: string | null;
  weekly_dow?: number | null;
  status?: string;
  last_fired_date?: string | null;
  source?: string | null;
}

interface LocalParts { date: string; hm: string; dow: number; minutes: number }

/**
 * Fires durable precise-time self-wakes (DECISION-016). Ticks every 60s and
 * delivers any due wake from `ll5_scheduled_wakes` as an [Agent Instruction]
 * (agent-private) or a user-facing reminder — the replacement for session-scoped
 * CronCreate. One-offs fire once at their instant; recurring wakes fire by local
 * wall-clock compare in the wake's effective timezone (DST-safe), deduped per
 * local day. No active-hours gate: the agent owns the timing decision.
 */
export class WakeScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: WakeSchedulerConfig,
  ) {}

  start(): void {
    logger.info('[WakeScheduler][start] started');
    this.timer = setInterval(() => void withSchedulerHealth('wake', () => this.tick()).catch(() => {}), 60_000);
    void withSchedulerHealth('wake', () => this.tick()).catch(() => {});
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private localParts(now: Date, zone: string): LocalParts {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
    }).formatToParts(now);
    const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
    const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return { date, hm: `${hh}:${mm}`, dow: map[wd] ?? 0, minutes: parseInt(hh, 10) * 60 + parseInt(mm, 10) };
  }

  private async tick(): Promise<void> {
    const { userId } = this.config;
    const now = new Date();
    const effectiveTz = await getEffectiveTimezone(this.pool, userId);

    const res = await this.es.search({
      index: INDEX,
      size: 200,
      query: { bool: { must: [{ term: { user_id: userId } }, { term: { status: 'pending' } }] } },
    }).catch((err) => {
      // Index may not exist yet on a fresh deploy — treat as "nothing due".
      logger.warn('[WakeScheduler][tick] search failed', { error: err instanceof Error ? err.message : String(err) });
      return null;
    });
    if (!res) return;

    for (const hit of res.hits.hits) {
      const id = hit._id as string;
      const w = hit._source as WakeDoc;
      const rec = w.recurrence ?? 'none';

      try {
        if (rec === 'none') {
          if (!w.fire_at) continue;
          const fireAt = new Date(w.fire_at);
          if (now < fireAt) continue;
          const ageH = (now.getTime() - fireAt.getTime()) / 3_600_000;
          if (ageH > ONEOFF_CATCHUP_HOURS) {
            await this.mark(id, { status: 'fired', fired_at: now.toISOString() });
            logger.warn('[WakeScheduler] one-off expired (missed window), not delivered', { id, ageH: Math.round(ageH) });
            continue;
          }
          await this.fire(userId, w);
          await this.mark(id, { status: 'fired', fired_at: now.toISOString() });
        } else {
          const zone = w.tz || effectiveTz;
          const L = this.localParts(now, zone);
          const matchesDay =
            rec === 'daily' ||
            (rec === 'weekdays' && L.dow >= 1 && L.dow <= 5) ||
            (rec === 'weekly' && w.weekly_dow === L.dow);
          if (!matchesDay || !w.fire_local) continue;
          if (w.last_fired_date === L.date) continue;
          const [th, tm] = w.fire_local.split(':').map(Number);
          const targetMin = th * 60 + tm;
          const since = L.minutes - targetMin;
          if (since < 0 || since > RECURRING_CATCHUP_MIN) continue;
          await this.fire(userId, w);
          await this.mark(id, { last_fired_date: L.date, last_fired_at: now.toISOString() });
        }
      } catch (err) {
        logger.warn('[WakeScheduler][tick] wake fire failed', { id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  private async fire(userId: string, w: WakeDoc): Promise<void> {
    const payload = (w.payload ?? '').trim() || '(no payload)';
    const evt = createSchedulerEvent('wake');
    if ((w.kind ?? 'instruction') === 'reminder') {
      await insertSystemMessage(this.pool, userId, `[Reminder] ${payload}`,
        { title: 'Reminder', type: 'wake_reminder', priority: 'high' }, evt);
    } else {
      const body = [
        '[Agent Instruction] A wake you scheduled for yourself is due:',
        '',
        payload,
        '',
        'This is your own scheduled wake, not a user reminder. Carry it out now using the context it carries. Surface something to the user only if it warrants their attention; otherwise journal the outcome.',
      ].join('\n');
      await insertSystemMessage(this.pool, userId, body,
        { title: 'Agent Instruction', type: 'agent_instruction', priority: 'normal' }, evt);
    }
  }

  private async mark(id: string, doc: Record<string, unknown>): Promise<void> {
    await this.es.update({ index: INDEX, id, doc, refresh: true }).catch((err) => {
      logger.warn('[WakeScheduler][mark] update failed', { id, error: err instanceof Error ? err.message : String(err) });
    });
  }
}
