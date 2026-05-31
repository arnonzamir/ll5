import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { withSchedulerHealth } from '../utils/scheduler-health.js';

interface AgentOutputConfig {
  /** How often to check (minutes). */
  intervalMinutes: number;
  /**
   * Minimum system-channel inbound rows in the lookback window before we
   * consider the agent "should have said something". Below this, silence is
   * legitimate (e.g., nothing happened worth reacting to).
   */
  minSystemInbound: number;
  /**
   * How many hours of agent-output silence triggers the alert. Measured from
   * `max(created_at) WHERE role='assistant' AND direction='outbound'`.
   */
  silenceHours: number;
  /** Lookback window for counting system-channel inbound rows. */
  lookbackHours: number;
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

export interface AgentOutputSnapshot {
  userId: string;
  /** Count of channel='system' inbound rows in the lookback window. */
  system_inbound_lookback: number;
  /** Most recent assistant-outbound timestamp, or null if none ever. */
  last_agent_outbound_at: string | null;
  /** Hours since last assistant outbound; null if never. */
  hours_since_last_outbound: number | null;
  /**
   * True if the agent wrote/updated a journal entry within the journal-alive
   * window (max(silenceHours, JOURNAL_ALIVE_FLOOR_HOURS) — deliberately more
   * generous than the chat-silence threshold so the agent's ~hourly overnight
   * journaling cadence still registers as alive). Journal writes are the agent's
   * silent-work signal (consolidation, ambient journaling) — they prove it's
   * alive even when it produces no chat outbound.
   */
  journal_active_in_window: boolean;
  /**
   * True when the agent has gone silent long enough and there were enough
   * scheduler triggers in the window that silence looks broken, not organic.
   */
  stale: boolean;
  checked_at: string;
}

/**
 * Minimum window (hours) for the journal-alive liveness check, independent of
 * the chat-silence threshold. The agent journals on a roughly hourly cadence
 * overnight; a window shorter than that produces false "agent silent" alarms in
 * the gaps between journals. 2h covers the natural cadence with margin while a
 * genuinely dead agent (no journal for 2h+) still trips the alert.
 */
const JOURNAL_ALIVE_FLOOR_HOURS = 2;

const CACHED_SNAPSHOT: Map<string, AgentOutputSnapshot> = new Map();

export function getAgentOutputSnapshot(userId: string): AgentOutputSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

export function getAllAgentOutputSnapshots(): AgentOutputSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

/**
 * Agent-output monitor — the sole "is the agent keeping up" signal on the
 * server-agent topology. Catches the blind spot mcp-health can't see: the
 * agent is connected and draining pending system messages (so nothing is
 * stale) but isn't actually producing any outbound replies that reach the
 * user. All other monitors report green while the user's phone stays silent
 * for hours. Throttle-aware by design: watches outbound flow, not pending
 * queue depth, so the channel MCP's intentional 1-event/5s delivery throttle
 * doesn't trigger false positives.
 *
 * Trips when, during active hours, the user received ≥ minSystemInbound
 * scheduler-triggered system rows in the last lookbackHours but the agent
 * hasn't emitted a single assistant-outbound row in silenceHours. FCM
 * critical, same cooldown/cap shape as the other failsafe monitors.
 */
export class AgentOutputMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastAlertAt: number = 0;
  private alertCount: number = 0;
  private readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000;
  private readonly MAX_ALERTS_PER_EPISODE = 2;

  constructor(
    private pool: Pool,
    private es: Client,
    private config: AgentOutputConfig,
  ) {}

  start(): void {
    logger.info('[AgentOutputMonitor][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      minSystemInbound: this.config.minSystemInbound,
      silenceHours: this.config.silenceHours,
      lookbackHours: this.config.lookbackHours,
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.config.intervalMinutes * 60 * 1000);
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

  private async tick(): Promise<void> {
    try { await withSchedulerHealth('agent_output_monitor', async () => {
      const lookbackMs = this.config.lookbackHours * 60 * 60 * 1000;
      const silenceMs = this.config.silenceHours * 60 * 60 * 1000;
      const lookbackSince = new Date(Date.now() - lookbackMs);

      const inboundResult = await this.pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count
         FROM chat_messages
         WHERE user_id = $1
           AND channel = 'system'
           AND direction = 'inbound'
           AND created_at > $2`,
        [this.config.userId, lookbackSince],
      );
      const systemInbound = parseInt(inboundResult.rows[0]?.count ?? '0', 10);

      const outboundResult = await this.pool.query<{ created_at: Date | null }>(
        `SELECT MAX(created_at) AS created_at
         FROM chat_messages
         WHERE user_id = $1
           AND direction = 'outbound'
           AND role = 'assistant'`,
        [this.config.userId],
      );
      const lastOutbound = outboundResult.rows[0]?.created_at ?? null;
      const hoursSinceLastOutbound = lastOutbound
        ? (Date.now() - new Date(lastOutbound).getTime()) / (60 * 60 * 1000)
        : null;

      // Is the agent doing silent work? Journal writes/updates (consolidation,
      // ambient journaling) prove it's alive even with zero chat outbound — the
      // false positive this monitor used to fire on. On ES error, don't suppress
      // (preserve the failsafe) — a rare false alarm beats masking a real outage.
      //
      // IMPORTANT: journaling is sparser than chat. Overnight the agent journals
      // on a roughly hourly cadence (consolidation/ambient notes), so checking
      // for journal activity only within the short chat-silence window
      // (`silenceHours`, often ~0.5h) misses the agent's own liveness signal in
      // the gaps between hourly journals and fires false "agent silent" alarms.
      // Give the journal-alive check its own GENEROUS window (floored at
      // JOURNAL_ALIVE_FLOOR_HOURS) so normal journaling reliably counts as alive,
      // while a genuinely dead agent (no journal for hours) still trips the alert.
      const journalWindowMs = Math.max(silenceMs, JOURNAL_ALIVE_FLOOR_HOURS * 60 * 60 * 1000);
      const journalSince = new Date(Date.now() - journalWindowMs).toISOString();
      let journalActive = false;
      try {
        const journalResult = await this.es.count({
          index: 'll5_agent_journal',
          query: {
            bool: {
              filter: [{ term: { user_id: this.config.userId } }],
              should: [
                { range: { created_at: { gte: journalSince } } },
                { range: { updated_at: { gte: journalSince } } },
              ],
              minimum_should_match: 1,
            },
          },
        });
        journalActive = journalResult.count > 0;
      } catch (err) {
        logger.warn('[AgentOutputMonitor][tick] journal activity check failed — not suppressing alert', {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Stale if the agent has been silent long enough on BOTH channels (no chat
      // outbound AND no journal activity) AND the schedulers have fired enough
      // that silence can't be explained by "nothing to say". Missing outbound
      // history entirely (null) counts as silent.
      const outboundSilent = lastOutbound === null
        || (Date.now() - new Date(lastOutbound).getTime() >= silenceMs);
      const silentEnough = outboundSilent && !journalActive;
      const stale = silentEnough && systemInbound >= this.config.minSystemInbound;

      const snapshot: AgentOutputSnapshot = {
        userId: this.config.userId,
        system_inbound_lookback: systemInbound,
        last_agent_outbound_at: lastOutbound ? new Date(lastOutbound).toISOString() : null,
        hours_since_last_outbound: hoursSinceLastOutbound !== null
          ? Math.round(hoursSinceLastOutbound * 10) / 10
          : null,
        journal_active_in_window: journalActive,
        stale,
        checked_at: new Date().toISOString(),
      };
      CACHED_SNAPSHOT.set(this.config.userId, snapshot);

      const snapshotCtx = { ...snapshot } as Record<string, unknown>;
      if (!stale) {
        if (this.alertCount > 0) {
          logger.info('[AgentOutputMonitor][tick] Agent producing output again, resetting alert counter', { alertCount: this.alertCount });
          this.alertCount = 0;
        }
        logger.debug('[AgentOutputMonitor][tick] Agent output healthy', snapshotCtx);
        return;
      }

      // Only alert during active hours
      const hour = this.getCurrentHour();
      if (hour < this.config.startHour || hour >= this.config.endHour) {
        logger.info('[AgentOutputMonitor][tick] Agent silent outside active hours — not alerting', snapshotCtx);
        return;
      }

      if (this.alertCount >= this.MAX_ALERTS_PER_EPISODE) {
        logger.debug('[AgentOutputMonitor][tick] Agent silent but max alerts reached', { alertCount: this.alertCount });
        return;
      }
      if (Date.now() - this.lastAlertAt < this.ALERT_COOLDOWN_MS) {
        logger.debug('[AgentOutputMonitor][tick] Agent silent but within cooldown', snapshotCtx);
        return;
      }
      this.lastAlertAt = Date.now();
      this.alertCount += 1;

      logger.error('[AgentOutputMonitor][alert] Agent has produced no output during active hours', snapshotCtx);

      const hoursFragment = hoursSinceLastOutbound !== null
        ? `${Math.round(hoursSinceLastOutbound * 10) / 10}h`
        : 'ever';
      await sendFCMNotification(this.pool, this.config.userId, {
        title: 'LL5 agent silent',
        body: `${systemInbound} scheduler triggers in the last ${this.config.lookbackHours}h but no agent reply OR journal activity in ${hoursFragment}. The agent appears genuinely unresponsive — check it.`,
        type: 'agent_silent',
        notification_level: 'critical',
        data: {
          system_inbound: String(systemInbound),
          hours_since_last_outbound: String(hoursSinceLastOutbound ?? 'null'),
        },
      });
    }); } catch {
      // withSchedulerHealth already recorded the failure + logged at error;
      // swallow here so setInterval keeps ticking.
    }
  }
}
