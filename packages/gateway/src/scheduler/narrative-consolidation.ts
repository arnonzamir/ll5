import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface NarrativeConsolidationConfig {
  enabled: boolean;
  timezone: string;
  userId: string;
  /** Fire every N hours within the active window. Default 3. */
  intervalHours: number;
  /** Only fire when the local minute is below this — keeps firing at the top of
   *  the hour so restarts mid-hour don't re-trigger / race delivery. Default 10. */
  fireWithinMinutes: number;
  /** Active window (local hours) — no consolidation outside it (quiet hours). */
  activeStartHour: number;
  activeEndHour: number;
  /** Don't re-nudge a narrative consolidated within this many hours (debounce). Default 6. */
  debounceHours: number;
  /** Only consider narratives with activity in the last N days. Default 14. */
  activeWindowDays: number;
  /** Max narratives to name in one nudge. Default 15. */
  maxNarratives: number;
  /** A subject with >= this many recent observations but NO narrative gets
   *  promoted (the agent is told to CREATE a narrative for it). Default 3. */
  promoteThreshold: number;
  /** Max orphan subjects to promote in one nudge. Default 10. */
  maxOrphans: number;
}

const NARRATIVES_INDEX = 'll5_knowledge_narratives';
const OBSERVATIONS_INDEX = 'll5_knowledge_observations';

interface StaleNarrative {
  subject: { kind: string; ref: string };
  title: string;
  /** True latest observation timestamp (live, from the observations index). */
  liveLastObservedAt: string;
}

/** A subject with accumulated observations but no narrative yet — promote it. */
interface OrphanSubject {
  subject: { kind: string; ref: string };
  count: number;
  /** A sample observation so the agent (and the nudge) knows what this is —
   *  person refs are UUIDs, so the text gives it an identity. */
  sample: string;
  latest: number;
}

/**
 * Narrative freshness trigger — keeps active narratives' summaries current.
 *
 * Cadenced + SERVER-SELECTED + debounced (the "live, always-fresh" loop):
 * instead of one daily blind nudge that makes the agent scan everything, this
 * fires every `intervalHours` within the active window and itself queries ES for
 * exactly the narratives that have new activity since they were last summarized
 * (`last_observed_at > last_consolidated_at`) and weren't refreshed in the last
 * `debounceHours`. It names those narratives so the agent consolidates precisely
 * them — no scan, and a fast-moving thread is refreshed at most once per debounce
 * window (so a 12-message burst is one rewrite, not twelve).
 *
 * Default-on; disable per-user via
 * user_settings.scheduler.narrative_consolidation_enabled = false.
 */
export class NarrativeConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunSlot: string | null = null;

  constructor(
    private es: Client,
    private pool: Pool,
    private config: NarrativeConsolidationConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      logger.info('[NarrativeConsolidationScheduler][start] Disabled — skipping (re-enable via user_settings.scheduler.narrative_consolidation_enabled=true)');
      return;
    }
    logger.info('[NarrativeConsolidationScheduler][start] Started', {
      intervalHours: this.config.intervalHours,
      activeWindow: `${this.config.activeStartHour}-${this.config.activeEndHour}`,
      debounceHours: this.config.debounceHours,
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
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        hour: 'numeric',
        hour12: false,
      }).format(new Date()),
      10,
    );
  }

  private getCurrentMinute(): number {
    return parseInt(
      new Intl.DateTimeFormat('en-US', {
        timeZone: this.config.timezone,
        minute: 'numeric',
      }).format(new Date()),
      10,
    );
  }

  private getCurrentDate(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: this.config.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  }

  /**
   * The freshness work for this tick:
   *  - `stale`: existing ACTIVE narratives with new activity since their last
   *    summary (refresh), measured against the LIVE max(observed_at) — never the
   *    denormalized `last_observed_at`, which only updates at consolidation.
   *  - `orphans`: subjects that have accumulated >= promoteThreshold recent
   *    observations but have NO narrative at all (CREATE). This is what makes
   *    net-new things you dealt with actually appear — without it, narratives are
   *    only ever refreshed, never born, so today's new people/topics stay invisible.
   *
   * Both are derived from one pass over recent observations aggregated by subject.
   */
  private async selectWork(): Promise<{ stale: StaleNarrative[]; orphans: OrphanSubject[] }> {
    const now = Date.now();
    const recentCutoff = now - this.config.activeWindowDays * 86_400_000;
    const debounceCutoff = now - this.config.debounceHours * 3_600_000;
    const sinceIso = new Date(recentCutoff).toISOString();

    // 1. All narratives (any status) → subject key set + the active ones' consolidation time.
    const nResp = await this.es.search<{ subject: { kind: string; ref: string }; status?: string; title?: string; last_consolidated_at?: string }>({
      index: NARRATIVES_INDEX,
      size: 500,
      _source: ['subject', 'status', 'title', 'last_consolidated_at'],
      query: { bool: { filter: [{ term: { user_id: this.config.userId } }] } },
    });
    const narrativeByKey = new Map<string, { status: string; title: string; lastConsolidatedAt?: string }>();
    for (const h of nResp.hits.hits) {
      const s = h._source;
      if (!s?.subject) continue;
      narrativeByKey.set(`${s.subject.kind}::${s.subject.ref}`, {
        status: s.status ?? 'active',
        title: s.title ?? '',
        lastConsolidatedAt: s.last_consolidated_at,
      });
    }

    // 2. Recent observations → aggregate by subject (count, latest, sample text).
    const oResp = await this.es.search<{ subjects?: Array<{ kind: string; ref: string }>; observed_at?: string; text?: string }>({
      index: OBSERVATIONS_INDEX,
      size: 2000,
      _source: ['subjects', 'observed_at', 'text'],
      query: { bool: { filter: [{ term: { user_id: this.config.userId } }, { range: { observed_at: { gte: sinceIso } } }] } },
      sort: [{ observed_at: { order: 'desc' } }],
    });
    const agg = new Map<string, { subject: { kind: string; ref: string }; count: number; latest: number; sample: string }>();
    for (const h of oResp.hits.hits) {
      const o = h._source;
      const t = o?.observed_at ? Date.parse(o.observed_at) : NaN;
      for (const s of o?.subjects ?? []) {
        const key = `${s.kind}::${s.ref}`;
        const cur = agg.get(key);
        if (cur) {
          cur.count += 1;
          if (Number.isFinite(t) && t > cur.latest) cur.latest = t;
        } else {
          agg.set(key, { subject: { kind: s.kind, ref: s.ref }, count: 1, latest: Number.isFinite(t) ? t : 0, sample: o?.text ?? '' });
        }
      }
    }

    // 3a. Stale (refresh existing active narratives with new activity, debounced).
    const stale: StaleNarrative[] = [];
    // 3b. Orphans (promote subjects with enough observations but no narrative).
    const orphans: OrphanSubject[] = [];
    for (const [key, a] of agg) {
      const narr = narrativeByKey.get(key);
      if (narr) {
        if (narr.status !== 'active') continue; // dormant/closed — leave it
        const con = narr.lastConsolidatedAt ? Date.parse(narr.lastConsolidatedAt) : NaN;
        const newSinceSummary = !Number.isFinite(con) || a.latest > con;
        const debounced = !Number.isFinite(con) || con <= debounceCutoff;
        if (newSinceSummary && debounced) {
          stale.push({ subject: a.subject, title: narr.title, liveLastObservedAt: new Date(a.latest).toISOString() });
        }
      } else if (a.count >= this.config.promoteThreshold) {
        orphans.push({ subject: a.subject, count: a.count, sample: a.sample, latest: a.latest });
      }
    }

    stale.sort((x, y) => Date.parse(y.liveLastObservedAt) - Date.parse(x.liveLastObservedAt));
    orphans.sort((x, y) => y.count - x.count || y.latest - x.latest);
    return {
      stale: stale.slice(0, this.config.maxNarratives),
      orphans: orphans.slice(0, this.config.maxOrphans),
    };
  }

  private async tick(): Promise<void> {
    try {
      const hour = this.getCurrentHour();
      const minute = this.getCurrentMinute();
      const date = this.getCurrentDate();

      // Active-window + cadence gating (quiet hours never fire).
      if (hour < this.config.activeStartHour || hour > this.config.activeEndHour) return;
      if (hour % this.config.intervalHours !== 0) return;
      // Only fire near the TOP of a qualifying hour. A gateway restart at an
      // arbitrary minute (deploys, the frequent ES-cascade restarts) must NOT
      // re-trigger a consolidation burst or race notify-delivery during the
      // reconnect window — it fires on the clean cadence boundary instead.
      if (minute >= this.config.fireWithinMinutes) return;

      const slot = `${date}:${hour}`;
      if (this.lastRunSlot === slot) return;
      this.lastRunSlot = slot;

      const { stale, orphans } = await this.selectWork();
      if (stale.length === 0 && orphans.length === 0) {
        logger.info('[NarrativeConsolidationScheduler][tick] Nothing to refresh or promote — skipping');
        return;
      }

      const sections: string[] = [
        `[Narrative Freshness] Keep the narrative set current — ${stale.length} to refresh, ${orphans.length} to create.`,
      ];
      if (stale.length > 0) {
        sections.push(
          `REFRESH these existing narratives (new activity since their last summary):`,
          stale.map((d) => `  - ${d.title} (${d.subject.kind}:${d.subject.ref})`).join('\n'),
        );
      }
      if (orphans.length > 0) {
        sections.push(
          `CREATE a narrative for each of these — they have accumulated observations but NO narrative yet (person refs are ids; the sample tells you who/what it is):`,
          orphans.map((o) => `  - ${o.subject.kind}:${o.subject.ref} (${o.count} obs) — e.g. "${(o.sample || '').slice(0, 70).replace(/\n/g, ' ')}"`).join('\n'),
        );
      }
      sections.push(
        'For REFRESH: consolidate_narrative({ subject }), draft an updated summary + current_mood + open_threads, then upsert_narrative with last_consolidated_at: <now>; transition to dormant if 60+ days quiet. ' +
        'For CREATE: consolidate_narrative({ subject }) to pull the observations, then upsert_narrative with a title (required), summary, open_threads, and last_consolidated_at: <now> — give it a clear human title (resolve person ids to names). ' +
        'Skip a CREATE only if the subject is genuinely a one-off non-thread. Silent — no push_to_user; brief journal note when done.',
      );

      const evt = createSchedulerEvent('narrative_consolidation');
      await insertSystemMessage(this.pool, this.config.userId, sections.join('\n'), undefined, evt);

      logger.info('[NarrativeConsolidationScheduler][tick] Freshness trigger sent', {
        refresh: stale.length,
        create: orphans.length,
      });
    } catch (err) {
      logger.warn('[NarrativeConsolidationScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
