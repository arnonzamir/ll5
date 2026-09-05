import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { GoogleCalendarClient } from './google-calendar-client.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';
import type { Escalation } from '../utils/escalation.js';

interface CompositeTriggerConfig {
  intervalMinutes: number; // ~3 min
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/** A gap ≥ this before next_event, with medium/high energy, is a "free block". */
const FREE_BLOCK_MIN_MINUTES = 45;
/** An inbound from an important contact unanswered longer than this is surfaced. */
const UNANSWERED_HOURS = 2;
/** How far ahead we look for the next calendar event when sizing a free block. */
const FREE_BLOCK_LOOKAHEAD_HOURS = 6;

interface MessageHit {
  _id: string;
  _source?: {
    sender?: string;
    app?: string;
    content?: string;
    is_group?: boolean;
    group_name?: string;
    conversation_id?: string;
    conversation_name?: string;
    from_me?: boolean;
    timestamp?: string;
  };
}

/**
 * Periodic evaluator for the time-based composite situations that can't be
 * fired purely event-driven (no single webhook marks "a free block just
 * opened" or "this message has now gone 2h unanswered"). Ticks ~every 3 min
 * during active hours, in the user's effective timezone, and fires an
 * IMMEDIATE `[Situation] …` message the moment a condition crosses its
 * threshold — so the user hears about it ~minutes later, not at the next
 * heartbeat.
 *
 * Composites here (the arrival composite is event-driven, in the location
 * processor):
 *   - M5 Free block opened — gap ≥45min before next_event, energy medium/high.
 *   - R1 Important contact unanswered >2h.
 *
 * Conservative by construction — every composite de-dupes (see each method) so
 * it surfaces a situation once, not on every 3-min tick.
 */
export class CompositeTriggerScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCheck = 0;
  private tz: string;

  // Free-block dedup: the next_event id of the gap we already announced.
  private firedFreeBlockEventIds = new Set<string>();
  // Unanswered-contact dedup: `conversation|YYYY-MM-DD` already surfaced.
  private firedUnansweredKeys = new Set<string>();
  // Daily reset bucket for both Sets so they don't grow unbounded and so a
  // contact can be re-surfaced on a new day if still unanswered.
  private lastResetDate: string | null = null;

  constructor(
    private pool: Pool,
    private es: Client,
    private googleClient: GoogleCalendarClient,
    private config: CompositeTriggerConfig,
  ) {
    this.tz = config.timezone;
  }

  start(): void {
    logger.info('[CompositeTriggerScheduler][start] Composite trigger scheduler started', {
      intervalMinutes: this.config.intervalMinutes,
      startHour: this.config.startHour,
      endHour: this.config.endHour,
      timezone: this.config.timezone,
    });
    this.timer = setInterval(() => void this.tick(), 60_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getCurrentHour(): number {
    return (parseInt(new Intl.DateTimeFormat('en-US', { timeZone: this.tz, hour: 'numeric', hour12: false }).format(new Date()), 10) % 24);
  }

  private getCurrentDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  private isWithinActiveHours(): boolean {
    const hour = this.getCurrentHour();
    return hour >= this.config.startHour && hour < this.config.endHour;
  }

  private async tick(): Promise<void> {
    // Resolve the effective tz once per tick so active-hours gating + the daily
    // dedup reset follow the user's current zone.
    this.tz = await getEffectiveTimezone(this.pool, this.config.userId);

    if (!this.isWithinActiveHours()) return;

    const now = Date.now();
    if (now - this.lastCheck < this.config.intervalMinutes * 60 * 1000) return;
    this.lastCheck = now;

    // Daily dedup reset.
    const today = this.getCurrentDate();
    if (this.lastResetDate !== today) {
      this.firedFreeBlockEventIds.clear();
      this.firedUnansweredKeys.clear();
      this.lastResetDate = today;
    }

    try {
      await withSchedulerHealth('composite_triggers', async () => {
        await this.checkFreeBlock();
        await this.checkUnansweredImportant();
      });
    } catch (err) {
      // withSchedulerHealth already recorded + logged; swallow so the interval
      // keeps running.
      logger.warn('[CompositeTriggerScheduler][tick] tick failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * M5 — Free block opened. A gap ≥45min before the next event, with
   * medium/high suggested energy, is worth a deep/medium action. Dedup per
   * next_event id (the gap is identified by what it leads up to), so we announce
   * a given free block once.
   */
  private async checkFreeBlock(): Promise<void> {
    const now = new Date();
    const lookahead = new Date(now.getTime() + FREE_BLOCK_LOOKAHEAD_HOURS * 60 * 60 * 1000);

    let events;
    try {
      events = await this.googleClient.getEvents(now.toISOString(), lookahead.toISOString());
    } catch (err) {
      logger.debug('[CompositeTriggerScheduler][freeBlock] getEvents failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // The next FUTURE, timed event (skip all-day, skip already-started).
    const next = events
      .filter((e) => !e.all_day && new Date(e.start).getTime() > now.getTime())
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())[0];

    // No next event in the window → there IS an open block, but with no anchor
    // to dedup on we stay conservative and don't fire (avoids re-firing every
    // tick of an empty day). The heartbeat covers the truly-empty day.
    if (!next) return;

    const gapMin = Math.round((new Date(next.start).getTime() - now.getTime()) / 60000);
    if (gapMin < FREE_BLOCK_MIN_MINUTES) return;

    const energy = this.suggestedEnergy();
    if (energy !== 'medium' && energy !== 'high') return;

    if (this.firedFreeBlockEventIds.has(next.event_id)) return;
    this.firedFreeBlockEventIds.add(next.event_id);

    const body =
      `[Situation] Free block — ~${gapMin} min until ${next.title} ` +
      `(starts ${this.formatTime(next.start)}). Suggested energy: ${energy}. ` +
      `Run situation-check M5: recommend_actions(energy: "${energy}", time_available: ${gapMin}) ` +
      `and propose one deep/medium action.`;

    const evt = createSchedulerEvent('composite_free_block');
    await insertSystemMessage(this.pool, this.config.userId, body, undefined, evt);
    logger.info('[CompositeTriggerScheduler][freeBlock] fired', {
      gapMin, nextEvent: next.title, energy,
    });
  }

  /**
   * R1 — Important contact unanswered > 2h. An inbound (from_me:false) from an
   * important conversation (escalated, or contact_settings routing
   * immediate/agent) with no outbound (from_me:true) after it for > 2h. Dedup
   * per conversation/day.
   */
  private async checkUnansweredImportant(): Promise<void> {
    const importantConvIds = await this.importantConversationIds();
    if (importantConvIds.size === 0) return;

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const cutoff = Date.now() - UNANSWERED_HOURS * 60 * 60 * 1000;

    let hits: MessageHit[];
    try {
      const res = await this.es.search({
        index: 'll5_awareness_messages',
        query: {
          bool: {
            filter: [
              { term: { user_id: this.config.userId } },
              { range: { timestamp: { gte: since } } },
            ],
          },
        },
        size: 500,
        sort: [{ timestamp: { order: 'asc' } }],
        _source: ['sender', 'app', 'content', 'conversation_id', 'conversation_name', 'group_name', 'from_me', 'timestamp', 'is_group'],
      });
      hits = res.hits.hits as MessageHit[];
    } catch (err) {
      logger.debug('[CompositeTriggerScheduler][unanswered] ES query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Per conversation, find the last inbound and whether anything outbound
    // came after it.
    interface ConvState {
      convId: string;
      name: string;
      lastInboundAt: number | null;
      lastInboundSnippet: string | null;
      lastOutboundAt: number | null;
    }
    const byConv = new Map<string, ConvState>();
    for (const h of hits) {
      const s = h._source;
      if (!s) continue;
      const convId = s.conversation_id ?? s.group_name ?? null;
      if (!convId || !importantConvIds.has(convId)) continue;
      const ts = s.timestamp ? new Date(s.timestamp).getTime() : null;
      if (ts == null) continue;
      let st = byConv.get(convId);
      if (!st) {
        st = { convId, name: s.conversation_name ?? s.group_name ?? convId, lastInboundAt: null, lastInboundSnippet: null, lastOutboundAt: null };
        byConv.set(convId, st);
      }
      if (s.from_me) {
        st.lastOutboundAt = ts;
      } else {
        st.lastInboundAt = ts;
        st.lastInboundSnippet = s.content ? s.content.slice(0, 100) : null;
      }
    }

    const today = this.getCurrentDate();
    for (const st of byConv.values()) {
      if (st.lastInboundAt == null) continue;
      // Answered if an outbound came AFTER the last inbound.
      if (st.lastOutboundAt != null && st.lastOutboundAt >= st.lastInboundAt) continue;
      // Must have been unanswered for > the threshold.
      if (st.lastInboundAt > cutoff) continue;

      const key = `${st.convId}|${today}`;
      if (this.firedUnansweredKeys.has(key)) continue;
      this.firedUnansweredKeys.add(key);

      const ageH = Math.round((Date.now() - st.lastInboundAt) / (60 * 60 * 1000));
      const snippet = st.lastInboundSnippet ? ` Last: "${st.lastInboundSnippet}"` : '';
      const body =
        `[Situation] ${st.name} unanswered for ${ageH}h.${snippet} ` +
        `Run situation-check R1: surface the decision needed and offer to draft a reply.`;

      const evt = createSchedulerEvent('composite_unanswered');
      await insertSystemMessage(this.pool, this.config.userId, body, undefined, evt);
      logger.info('[CompositeTriggerScheduler][unanswered] fired', { conversation: st.convId, ageH });
    }
  }

  /**
   * Important conversation ids = escalated conversations (user_settings) +
   * contact_settings with routing immediate/agent. We key on the conversation
   * id / target_id; group chats match directly. Conservative: only clearly
   * important conversations qualify.
   */
  private async importantConversationIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const esc = await this.pool.query<{ esc: Escalation[] | null }>(
        "SELECT settings->'active_escalations' AS esc FROM user_settings WHERE user_id = $1",
        [this.config.userId],
      );
      for (const e of esc.rows[0]?.esc ?? []) {
        if (e.conversation_id) ids.add(e.conversation_id);
      }
    } catch (err) {
      logger.debug('[CompositeTriggerScheduler][important] escalation read failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      const cs = await this.pool.query<{ target_id: string }>(
        `SELECT target_id FROM contact_settings
         WHERE user_id = $1::uuid AND routing IN ('immediate', 'agent')`,
        [this.config.userId],
      );
      for (const r of cs.rows) {
        if (r.target_id) ids.add(r.target_id);
      }
    } catch (err) {
      // 22P02 = invalid uuid (webhook-token fallback user id isn't a uuid);
      // 42P01 = table absent. Either way, escalations alone still drive R1.
      const code = (err as { code?: string } | null)?.code;
      if (code !== '22P02' && code !== '42P01') {
        logger.debug('[CompositeTriggerScheduler][important] contact_settings read failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return ids;
  }

  /**
   * Coarse energy heuristic by local time-of-day (the gateway has no
   * suggested_energy of its own; the agent's get_situation derives a richer
   * one). Morning/early-afternoon = high, late afternoon = medium, otherwise
   * low. Good enough to gate the free-block composite conservatively.
   */
  private suggestedEnergy(): 'low' | 'medium' | 'high' {
    const hour = this.getCurrentHour();
    if (hour >= 8 && hour < 13) return 'high';
    if (hour >= 13 && hour < 18) return 'medium';
    return 'low';
  }

  private formatTime(isoString: string): string {
    return new Date(isoString).toLocaleTimeString('en-US', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.tz,
    });
  }
}
