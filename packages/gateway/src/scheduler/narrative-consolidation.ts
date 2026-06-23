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
}

const NARRATIVES_INDEX = 'll5_knowledge_narratives';
const OBSERVATIONS_INDEX = 'll5_knowledge_observations';

interface ActiveNarrativeDoc {
  subject: { kind: string; ref: string };
  title: string;
  last_consolidated_at?: string;
}

interface StaleNarrative {
  subject: { kind: string; ref: string };
  title: string;
  /** True latest observation timestamp (live, from the observations index). */
  liveLastObservedAt: string;
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
   * Narratives that are active, recently touched, have new activity since their
   * last summary, and weren't refreshed within the debounce window.
   *
   * Critically, "new activity" is measured against the LIVE latest observation
   * timestamp (max(observed_at) from the observations index), NOT the narrative
   * doc's `last_observed_at` — that field is only written at consolidation, so it
   * always trails `last_consolidated_at` and would make this selection blind.
   * We pull active narratives, compute live max(observed_at) per subject in one
   * filters-aggregation, and select on that.
   */
  private async selectStaleNarratives(): Promise<StaleNarrative[]> {
    const now = Date.now();
    const recentCutoff = now - this.config.activeWindowDays * 86_400_000;
    const debounceCutoff = now - this.config.debounceHours * 3_600_000;

    // 1. Active narratives (bounded; working sets are dozens).
    const resp = await this.es.search<ActiveNarrativeDoc>({
      index: NARRATIVES_INDEX,
      size: 200,
      _source: ['subject', 'title', 'last_consolidated_at'],
      query: {
        bool: {
          filter: [
            { term: { user_id: this.config.userId } },
            { term: { status: 'active' } },
          ],
        },
      },
    });
    const actives = resp.hits.hits
      .map((h) => h._source)
      .filter((d): d is ActiveNarrativeDoc => d != null && d.subject != null);
    if (actives.length === 0) return [];

    // 2. Live max(observed_at) per subject — one filters-agg over observations.
    const filters: Record<string, unknown> = {};
    for (const d of actives) {
      filters[`${d.subject.kind}::${d.subject.ref}`] = {
        nested: {
          path: 'subjects',
          query: {
            bool: {
              must: [
                { term: { 'subjects.kind': d.subject.kind } },
                { term: { 'subjects.ref': d.subject.ref } },
              ],
            },
          },
        },
      };
    }
    const liveMax = new Map<string, number>();
    try {
      // Loose-typed body: the ES client's strict aggs typing rejects a
      // dynamically-built filters map (same reason the knowledge repo uses a
      // Record<string, any> query alias).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const searchBody: any = {
        index: OBSERVATIONS_INDEX,
        size: 0,
        query: { bool: { filter: [{ term: { user_id: this.config.userId } }] } },
        aggs: {
          per_subject: {
            filters: { filters },
            aggs: { last_obs: { max: { field: 'observed_at' } } },
          },
        },
      };
      const agg = await this.es.search(searchBody);
      const buckets =
        (agg.aggregations as {
          per_subject?: { buckets?: Record<string, { last_obs?: { value?: number } }> };
        })?.per_subject?.buckets ?? {};
      for (const [key, b] of Object.entries(buckets)) {
        if (b.last_obs?.value != null) liveMax.set(key, b.last_obs.value);
      }
    } catch (err) {
      logger.warn('[NarrativeConsolidationScheduler] live max(observed_at) agg failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    // 3. Select: warm + new activity since last summary + debounced.
    const stale: StaleNarrative[] = [];
    for (const d of actives) {
      const key = `${d.subject.kind}::${d.subject.ref}`;
      const last = liveMax.get(key);
      if (last == null || last < recentCutoff) continue; // no obs / gone cold
      const con = d.last_consolidated_at ? Date.parse(d.last_consolidated_at) : NaN;
      const newSinceSummary = !Number.isFinite(con) || last > con;
      const debounced = !Number.isFinite(con) || con <= debounceCutoff;
      if (newSinceSummary && debounced) {
        stale.push({ subject: d.subject, title: d.title, liveLastObservedAt: new Date(last).toISOString() });
      }
    }
    return stale
      .sort((a, b) => Date.parse(b.liveLastObservedAt) - Date.parse(a.liveLastObservedAt))
      .slice(0, this.config.maxNarratives);
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

      const stale = await this.selectStaleNarratives();
      if (stale.length === 0) {
        logger.info('[NarrativeConsolidationScheduler][tick] No stale-active narratives — skipping');
        return;
      }

      const list = stale
        .map((d) => `  - ${d.title} (${d.subject.kind}:${d.subject.ref})`)
        .join('\n');

      const evt = createSchedulerEvent('narrative_consolidation');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        [
          `[Narrative Freshness] ${stale.length} active narrative(s) have new activity since their last summary. Refresh each:`,
          list,
          'For each: consolidate_narrative({ subject }), draft an updated summary + current_mood + open_threads from the new observations, then upsert_narrative with last_consolidated_at: <now>. If any has gone quiet for 60+ days with no recent signal, transition it to dormant instead. Silent — no push_to_user; brief journal note when done.',
        ].join('\n'),
        undefined,
        evt,
      );

      logger.info('[NarrativeConsolidationScheduler][tick] Freshness trigger sent', {
        count: stale.length,
      });
    } catch (err) {
      logger.warn('[NarrativeConsolidationScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
