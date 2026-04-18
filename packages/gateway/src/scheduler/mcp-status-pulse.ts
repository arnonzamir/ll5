import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { sendFCMNotification } from '../utils/fcm-sender.js';
import { getHealthSnapshot } from './mcp-health-monitor.js';
import { getLivenessSnapshot } from './channel-liveness-monitor.js';
import { getWhatsAppFlowSnapshot } from './whatsapp-flow-monitor.js';
import { getPhoneLivenessSnapshot } from './phone-liveness-monitor.js';

interface PulseConfig {
  /** How often to send a status pulse (minutes). */
  intervalMinutes: number;
  /** Stop firing after this absolute ISO timestamp. Intended for a short
   *  stabilisation window after deploying new monitors. */
  expiresAt: string;
  /** Only pulse during active hours (otherwise you'd get vibrated overnight). */
  startHour: number;
  endHour: number;
  timezone: string;
  userId: string;
}

/**
 * Temporary scheduler: sends a periodic "all monitors say X" FCM at notify-level
 * so the user gets regular visibility into MCP/phone/WhatsApp health without
 * having to open the dashboard. Auto-expires at config.expiresAt — after which
 * the existing failsafe monitors (which only fire on failure) remain.
 */
export class MCPStatusPulseScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pool: Pool,
    private config: PulseConfig,
  ) {}

  start(): void {
    const remainingMs = new Date(this.config.expiresAt).getTime() - Date.now();
    if (remainingMs <= 0) {
      logger.info('[MCPStatusPulse][start] Already past expiresAt — not starting', {
        userId: this.config.userId,
        expiresAt: this.config.expiresAt,
      });
      return;
    }
    logger.info('[MCPStatusPulse][start] Started', {
      userId: this.config.userId,
      intervalMinutes: this.config.intervalMinutes,
      expiresAt: this.config.expiresAt,
      remainingHours: Math.round(remainingMs / 3600 / 1000),
    });
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
    // Auto-expire
    if (Date.now() >= new Date(this.config.expiresAt).getTime()) {
      logger.info('[MCPStatusPulse][tick] Expired, stopping', { userId: this.config.userId });
      this.stop();
      return;
    }

    // Active-hours gate
    const hour = this.getCurrentHour();
    if (hour < this.config.startHour || hour >= this.config.endHour) {
      logger.debug('[MCPStatusPulse][tick] Outside active hours, skipping', {
        hour, startHour: this.config.startHour, endHour: this.config.endHour,
      });
      return;
    }

    try {
      const services = getHealthSnapshot();
      const channel = getLivenessSnapshot(this.config.userId);
      const whatsapp = getWhatsAppFlowSnapshot(this.config.userId);
      const phone = getPhoneLivenessSnapshot(this.config.userId);

      const unhealthy = services.filter((s) => !s.healthy);
      const channelStale = channel?.stale ?? false;
      const whatsappStale = whatsapp?.stale ?? false;
      const phoneStale = phone?.stale ?? false;

      const allGreen =
        unhealthy.length === 0 && !channelStale && !whatsappStale && !phoneStale;

      const parts: string[] = [];
      parts.push(allGreen
        ? `All ${services.length} MCPs green`
        : `${services.length - unhealthy.length}/${services.length} MCPs green`);
      if (unhealthy.length > 0) parts.push(`down: ${unhealthy.map((s) => s.name).join(',')}`);
      if (channelStale && channel) {
        parts.push(`channel stalled (${channel.pending_inbound} pending, oldest ${Math.round((channel.oldest_pending_age_seconds ?? 0) / 60)}min)`);
      }
      if (whatsappStale && whatsapp) {
        parts.push(`WhatsApp ${Math.round(whatsapp.last_message_age_hours ?? 0)}h stale`);
      }
      if (phoneStale && phone) {
        parts.push(`phone ${Math.round(phone.last_signal_age_hours ?? 0)}h silent`);
      }

      const body = parts.join(' · ');
      const level: 'notify' | 'silent' = allGreen ? 'silent' : 'notify';

      logger.info('[MCPStatusPulse][tick] Pulse', {
        userId: this.config.userId, allGreen, body, level,
      });

      await sendFCMNotification(this.pool, this.config.userId, {
        title: allGreen ? 'LL5 status: all good' : 'LL5 status',
        body,
        type: 'mcp_status_pulse',
        notification_level: level,
        data: {
          all_green: String(allGreen),
          services_down: String(unhealthy.length),
          channel_stale: String(channelStale),
          whatsapp_stale: String(whatsappStale),
          phone_stale: String(phoneStale),
        },
      });
    } catch (err) {
      logger.warn('[MCPStatusPulse][tick] Failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
