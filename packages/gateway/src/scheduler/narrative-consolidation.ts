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

interface StaleNarrativeDoc {
  subject: { kind: string; ref: string };
  title: string;
  last_observed_at?: string;
  last_consolidated_at?: string;
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
   * last summary, and weren't refreshed within the debounce window. Comparing two
   * date fields (last_observed_at > last_consolidated_at) isn't a plain ES filter,
   * so we filter "never/long-ago consolidated" in ES and do the field-vs-field
   * comparison in JS on the bounded candidate set.
   */
  private async selectStaleNarratives(): Promise<StaleNarrativeDoc[]> {
    const now = Date.now();
    const recentCutoff = new Date(now - this.config.activeWindowDays * 86_400_000).toISOString();
    const debounceCutoff = new Date(now - this.config.debounceHours * 3_600_000).toISOString();

    const resp = await this.es.search<StaleNarrativeDoc>({
      index: NARRATIVES_INDEX,
      size: this.config.maxNarratives * 3,
      _source: ['subject', 'title', 'last_observed_at', 'last_consolidated_at'],
      query: {
        bool: {
          filter: [
            { term: { user_id: this.config.userId } },
            { term: { status: 'active' } },
            { range: { last_observed_at: { gte: recentCutoff } } },
          ],
          should: [
            { bool: { must_not: { exists: { field: 'last_consolidated_at' } } } },
            { range: { last_consolidated_at: { lte: debounceCutoff } } },
          ],
          minimum_should_match: 1,
        },
      },
      sort: [{ last_observed_at: { order: 'desc', missing: '_last' } }],
    });

    return resp.hits.hits
      .map((h) => h._source)
      .filter((d): d is StaleNarrativeDoc => d != null)
      // New activity since the last summary (or never summarized).
      .filter((d) => {
        if (!d.last_consolidated_at) return true;
        const obs = d.last_observed_at ? Date.parse(d.last_observed_at) : NaN;
        const con = Date.parse(d.last_consolidated_at);
        return Number.isFinite(obs) && obs > con;
      })
      .slice(0, this.config.maxNarratives);
  }

  private async tick(): Promise<void> {
    try {
      const hour = this.getCurrentHour();
      const date = this.getCurrentDate();

      // Active-window + cadence gating (quiet hours never fire).
      if (hour < this.config.activeStartHour || hour > this.config.activeEndHour) return;
      if (hour % this.config.intervalHours !== 0) return;

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
