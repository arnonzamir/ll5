import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone, startOfDayInTz } from '../utils/timezone.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface EveningCloseConfig {
  enabled: boolean;
  /** Local hour the close fires (default 20). */
  closeHour: number;
  /** Local minute within the hour (default 30 → 20:30). */
  closeMinute: number;
  timezone: string;
  userId: string;
}

// The beat fires anywhere within [target, target + CATCHUP] so a gateway restart
// at 20:47 still delivers the 20:30 close — but a half-day outage doesn't fire a
// stale close at 03:00. Combined with the durable already-sent check below this
// makes the beat restart-safe in both directions (no skip, no double-fire).
const CATCHUP_MINUTES = 60;
// Cap the embedded collection so the nudge stays digestible (the narrative-
// freshness lesson: a 24-item nudge makes the agent balk and do nothing).
const MAX_ITEMS = 10;
const ITEM_MAX_CHARS = 140;

const JOURNAL_INDEX = 'll5_agent_journal';

interface CollectedItem { line: string }

/**
 * Evening close beat (DECISION-018 §1-2). Fires once per local evening (default
 * 20:30) and inserts ONE [Evening Close] system message. The nudge is
 * SELF-CARRYING: the gateway itself collects the day's unengaged staged items —
 * silent/staged assistant chat messages, still-open journal entries, and today's
 * habit outcomes — so resurfacing does not depend on agent recall. The agent's
 * contract: one notify-level close with a pick-up/drop call on every item.
 * A silent staging is a deferral, not a delivery.
 */
export class EveningCloseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunDate: string | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: EveningCloseConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      logger.info('[EveningCloseScheduler][start] Disabled — skipping (re-enable via user_settings.scheduler.evening_close_enabled=true)');
      return;
    }
    logger.info('[EveningCloseScheduler][start] Started', {
      closeHour: this.config.closeHour,
      closeMinute: this.config.closeMinute,
      timezone: this.config.timezone,
    });
    this.timer = setInterval(() => void withSchedulerHealth('evening_close', () => this.tick()).catch(() => {}), 60_000);
    void withSchedulerHealth('evening_close', () => this.tick()).catch(() => {});
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private localParts(now: Date, zone: string): { date: string; minutes: number } {
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const hh = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const mm = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    return { date, minutes: hh * 60 + mm };
  }

  private truncateLine(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > ITEM_MAX_CHARS ? `${flat.slice(0, ITEM_MAX_CHARS)}…` : flat;
  }

  private formatTime(iso: string | Date, zone: string): string {
    return new Date(iso).toLocaleTimeString('en-GB', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }

  /**
   * Today's staged/unengaged assistant messages: non-compact assistant outbound
   * rows with NO subsequent user message in the conversation.
   *
   * SILENT-LEVEL DETECTION: `notification_level` is a POST /chat/messages body
   * field that only drives the FCM push — it is NOT persisted as a column, and
   * the gateway does not copy it into metadata. If the writing client happened
   * to include a level in `metadata` (notification_level/level keys) we surface
   * it per item; otherwise we fall back to the DECISION-018 heuristic: any
   * non-compact assistant message the user never replied to after is treated as
   * staged-and-unengaged. Open journal entries (below) cover the rest of the
   * silent-staging surface.
   */
  private async collectStagedMessages(dayStart: Date, zone: string): Promise<CollectedItem[]> {
    try {
      const res = await this.pool.query<{ content: string | null; created_at: Date; level: string | null }>(
        `SELECT m.content, m.created_at,
                COALESCE(m.metadata->>'notification_level', m.metadata->>'level') AS level
         FROM chat_messages m
         WHERE m.user_id = $1
           AND m.role = 'assistant'
           AND m.direction = 'outbound'
           AND m.created_at >= $2
           AND COALESCE(m.display_compact, false) = false
           AND m.content IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM chat_messages u
             WHERE u.user_id = m.user_id
               AND u.conversation_id = m.conversation_id
               AND u.role = 'user'
               AND u.created_at > m.created_at
           )
         ORDER BY m.created_at ASC
         LIMIT 30`,
        [this.config.userId, dayStart.toISOString()],
      );
      return res.rows.map((r) => ({
        line: `- [staged msg ${this.formatTime(r.created_at, zone)}${r.level ? `, ${r.level}` : ''}] ${this.truncateLine(r.content ?? '')}`,
      }));
    } catch (err) {
      logger.warn('[EveningCloseScheduler][collect] staged-message query failed — skipping section', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Today's still-open agent journal entries (same client pattern as journal-health). */
  private async collectOpenJournal(dayStart: Date): Promise<CollectedItem[]> {
    try {
      const res = await this.es.search<{ topic?: string; content?: string }>({
        index: JOURNAL_INDEX,
        size: 20,
        _source: ['topic', 'content'],
        sort: [{ created_at: { order: 'asc' } }],
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { term: { status: 'open' } },
              { range: { created_at: { gte: dayStart.toISOString() } } },
            ],
          },
        },
      });
      return res.hits.hits.map((h) => {
        const s = h._source;
        const topic = s?.topic ? `${s.topic}: ` : '';
        return { line: `- [open journal] ${this.truncateLine(`${topic}${s?.content ?? ''}`)}` };
      });
    } catch (err) {
      logger.warn('[EveningCloseScheduler][collect] open-journal query failed — skipping section', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Today's habit outcomes from gtd_habit_log (DECISION-019 — ships in the same
   * release from the gtd workstream). Queried defensively: a missing table
   * (42P01, pre-migration deploy) logs and skips the section, never crashes the beat.
   */
  private async collectHabitOutcomes(localDate: string): Promise<CollectedItem[]> {
    try {
      const res = await this.pool.query<{ name: string; due_time: string; outcome: string | null }>(
        `SELECT h.name, l.due_time, l.outcome
         FROM gtd_habit_log l
         JOIN gtd_habits h ON h.id = l.habit_id
         WHERE l.user_id = $1 AND l.due_date = $2
         ORDER BY l.due_time ASC`,
        [this.config.userId, localDate],
      );
      return res.rows.map((r) => ({
        line: `- [habit] ${r.name} @ ${r.due_time} — ${r.outcome ?? 'OPEN (no outcome logged yet)'}`,
      }));
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === '42P01') {
        logger.warn('[EveningCloseScheduler][collect] gtd_habit_log/gtd_habits missing (pre-migration) — skipping habit section');
      } else {
        logger.warn('[EveningCloseScheduler][collect] habit-outcome query failed — skipping section', {
          code, error: err instanceof Error ? err.message : String(err),
        });
      }
      return [];
    }
  }

  /** Durable already-sent check: has an [Evening Close] system row landed today? */
  private async alreadySentToday(dayStart: Date): Promise<boolean> {
    try {
      const res = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM chat_messages
         WHERE user_id = $1 AND role = 'system' AND created_at >= $2
           AND content LIKE '[Evening Close]%'`,
        [this.config.userId, dayStart.toISOString()],
      );
      return parseInt(res.rows[0]?.count ?? '0', 10) > 0;
    } catch (err) {
      // If the check itself fails, prefer firing (the in-memory dedup still holds
      // within a process lifetime) over silently skipping the beat.
      logger.warn('[EveningCloseScheduler][tick] already-sent check failed — proceeding', {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  private async tick(): Promise<void> {
    const now = new Date();
    const zone = await getEffectiveTimezone(this.pool, this.config.userId);
    const L = this.localParts(now, zone);

    // Fire-within-window gate + per-day dedup: fires anywhere in
    // [target, target+CATCHUP] once per local day.
    const targetMin = this.config.closeHour * 60 + this.config.closeMinute;
    const since = L.minutes - targetMin;
    if (since < 0 || since > CATCHUP_MINUTES) return;
    if (this.lastRunDate === L.date) return;

    const dayStart = startOfDayInTz(now, zone);

    // Restart-safety: the in-memory dedup dies with the process, so a 20:47
    // restart would double-fire without this durable check against the very
    // table we insert into.
    if (await this.alreadySentToday(dayStart)) {
      this.lastRunDate = L.date;
      return;
    }
    this.lastRunDate = L.date;

    const [staged, journal, habits] = await Promise.all([
      this.collectStagedMessages(dayStart, zone),
      this.collectOpenJournal(dayStart),
      this.collectHabitOutcomes(L.date),
    ]);

    const all = [...staged, ...journal, ...habits];
    const shown = all.slice(0, MAX_ITEMS);
    const overflow = all.length - shown.length;

    const lines: string[] = [
      '[Evening Close] Evening close beat.',
      'Run your evening-close skill: ONE message at notify level — max 3 loose ends, tomorrow\'s ONE thing, today\'s habit outcomes, and an explicit pick-up/drop call on each staged item below. A silent staging is a deferral, not a delivery. If the skill is unavailable, do the close inline from this instruction — never skip.',
      '',
    ];
    if (shown.length > 0) {
      lines.push(`Today's collection (${all.length} item${all.length === 1 ? '' : 's'} — gateway-gathered, decide pick-up or drop on each):`);
      lines.push(...shown.map((i) => i.line));
      if (overflow > 0) lines.push(`(+${overflow} more item${overflow === 1 ? '' : 's'} not shown — query today's messages/journal for the rest)`);
    } else {
      lines.push('Today\'s collection is empty — no unengaged staged messages, open journal entries, or habit rows. Still deliver the close (loose ends, tomorrow\'s ONE thing).');
    }

    const evt = createSchedulerEvent('evening_close');
    await insertSystemMessage(this.pool, this.config.userId, lines.join('\n'), undefined, evt);

    logger.info('[EveningCloseScheduler][tick] Evening close sent', {
      staged: staged.length, journal: journal.length, habits: habits.length, overflow,
    });
  }
}
