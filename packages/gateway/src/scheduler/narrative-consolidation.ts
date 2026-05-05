import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';

interface NarrativeConsolidationConfig {
  enabled: boolean;
  consolidationHour: number;
  timezone: string;
  userId: string;
}

/**
 * Periodic narrative consolidation trigger. Default-off; enable per-user via
 * user_settings.scheduler.narrative_consolidation_enabled = true.
 *
 * The scheduler doesn't itself decide which narratives to consolidate — it just
 * nudges the agent to scan list_narratives for threads that have accumulated
 * enough new observations since last_consolidated_at. The agent does the work.
 */
export class NarrativeConsolidationScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRunDate: string | null = null;

  constructor(
    private pool: Pool,
    private config: NarrativeConsolidationConfig,
  ) {}

  start(): void {
    if (!this.config.enabled) {
      logger.info('[NarrativeConsolidationScheduler][start] Disabled — skipping (enable via user_settings.scheduler.narrative_consolidation_enabled)');
      return;
    }
    logger.info('[NarrativeConsolidationScheduler][start] Started', {
      consolidationHour: this.config.consolidationHour,
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

  private async tick(): Promise<void> {
    try {
      const currentHour = this.getCurrentHour();
      const currentDate = this.getCurrentDate();

      if (currentHour !== this.config.consolidationHour) return;
      if (this.lastRunDate === currentDate) return;

      this.lastRunDate = currentDate;

      const evt = createSchedulerEvent('narrative_consolidation');
      await insertSystemMessage(
        this.pool,
        this.config.userId,
        '[Narrative Consolidation] Time to refresh narratives. Call list_narratives({ status: "active", limit: 50 }) and for each narrative with ≥5 new observations since last_consolidated_at, call consolidate_narrative({ subject }), draft an updated summary + current_mood + open_threads, then upsert_narrative with last_consolidated_at: <now>. If a narrative has gone quiet for 60+ days with no recent signal, consider transitioning it to dormant. This is silent — no push_to_user; just brief journal note when done.',
        undefined,
        evt,
      );

      logger.info('[NarrativeConsolidationScheduler][tick] Consolidation trigger sent');
    } catch (err) {
      logger.warn('[NarrativeConsolidationScheduler][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
