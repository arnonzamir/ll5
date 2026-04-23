import type { Pool } from 'pg';
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
   * True when the agent has gone silent long enough and there were enough
   * scheduler triggers in the window that silence looks broken, not organic.
   */
  stale: boolean;
  checked_at: string;
}

const CACHED_SNAPSHOT: Map<string, AgentOutputSnapshot> = new Map();

export function getAgentOutputSnapshot(userId: string): AgentOutputSnapshot | undefined {
  return CACHED_SNAPSHOT.get(userId);
}

export function getAllAgentOutputSnapshots(): AgentOutputSnapshot[] {
  return [...CACHED_SNAPSHOT.values()];
}

/**
 * Agent-output monitor — catches the blind spot that channel-liveness and
 * mcp-health can't see: the laptop-side agent is connected and draining
 * pending system messages (so nothing is stale), but it isn't actually
 * producing any outbound replies that reach the user. All other monitors
 * report green while the user's phone stays silent for hours.
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

      // Stale if the agent has been silent long enough AND the schedulers
      // have fired enough that silence can't be explained by "nothing to say".
      // Missing outbound history entirely (null) counts as silent.
      const silentEnough = lastOutbound === null
        || (Date.now() - new Date(lastOutbound).getTime() >= silenceMs);
      const stale = silentEnough && systemInbound >= this.config.minSystemInbound;

      const snapshot: AgentOutputSnapshot = {
        userId: this.config.userId,
        system_inbound_lookback: systemInbound,
        last_agent_outbound_at: lastOutbound ? new Date(lastOutbound).toISOString() : null,
        hours_since_last_outbound: hoursSinceLastOutbound !== null
          ? Math.round(hoursSinceLastOutbound * 10) / 10
          : null,
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
        body: `${systemInbound} scheduler triggers in the last ${this.config.lookbackHours}h but no agent reply in ${hoursFragment}. Check the laptop — channel MCP may be draining but the agent isn't responding.`,
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
