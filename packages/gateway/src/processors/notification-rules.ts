import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { isEscalated } from '../utils/escalation.js';

export type Priority = 'immediate' | 'batch' | 'ignore' | 'agent';

interface Rule {
  id: string;
  rule_type: string;
  match_value: string;
  priority: Priority;
  platform: string | null;
  download_images: boolean;
}

export class NotificationRuleMatcher {
  private rules: Map<string, Rule[]> = new Map(); // userId -> rules
  private lastRefresh = 0;
  private refreshInterval = 5 * 60 * 1000; // 5 minutes

  constructor(private pool: Pool) {}

  private async refresh(): Promise<void> {
    if (Date.now() - this.lastRefresh < this.refreshInterval) return;
    try {
      const result = await this.pool.query<{ user_id: string } & Rule>(
        'SELECT id, user_id, rule_type, match_value, priority, platform, download_images FROM notification_rules',
      );
      this.rules.clear();
      for (const row of result.rows) {
        const list = this.rules.get(row.user_id) || [];
        list.push({
          id: row.id,
          rule_type: row.rule_type,
          match_value: row.match_value,
          priority: row.priority as Priority,
          platform: row.platform ?? null,
          download_images: row.download_images ?? false,
        });
        this.rules.set(row.user_id, list);
      }
      this.lastRefresh = Date.now();
    } catch (err) {
      logger.warn('[NotificationRuleMatcher][refresh] Failed to refresh notification rules', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get contact settings for a person or group from the contact_settings table.
   */
  async getContactSettings(
    userId: string,
    targetType: 'person' | 'group',
    targetId: string,
  ): Promise<{ routing: Priority; permission: string; download_media: boolean } | null> {
    try {
      const result = await this.pool.query(
        'SELECT routing, permission, download_media FROM contact_settings WHERE user_id = $1 AND target_type = $2 AND target_id = $3',
        [userId, targetType, targetId],
      );
      if (result.rows.length === 0) return null;
      return result.rows[0];
    } catch {
      return null;
    }
  }

  async match(
    userId: string,
    message: {
      sender: string;
      app: string;
      body: string;
      is_group?: boolean;
      group_name?: string | null;
      platform?: string;
      conversation_id?: string;
      person_id?: string;
    },
  ): Promise<Priority | null> {
    await this.refresh();

    const senderLower = message.sender.toLowerCase();
    const bodyLower = message.body.toLowerCase();
    const appLower = message.app.toLowerCase();

    // 0. Check for active escalation — overrides all rules with 'immediate'
    if (message.platform && message.conversation_id) {
      const escalated = await isEscalated(this.pool, userId, message.platform, message.conversation_id);
      if (escalated) {
        logger.debug('[NotificationRuleMatcher][match] Escalation active, returning immediate', {
          platform: message.platform, conversationId: message.conversation_id,
        });
        return 'immediate';
      }
    }

    // 1. Contact settings — unified person/group rules (new system)
    if (message.is_group && message.conversation_id) {
      // Group message → check group contact_settings
      const groupSettings = await this.getContactSettings(userId, 'group', message.conversation_id);
      if (groupSettings) {
        return groupSettings.routing as Priority;
      }
    } else if (!message.is_group && message.person_id) {
      // 1:1 message → check person contact_settings
      const personSettings = await this.getContactSettings(userId, 'person', message.person_id);
      if (personSettings) {
        return personSettings.routing as Priority;
      }
    }

    // 2. Legacy conversation-specific rules (from notification_rules, backward compat)
    const userRules = this.rules.get(userId);
    if (!userRules || userRules.length === 0) return null;

    if (message.platform && message.conversation_id) {
      for (const rule of userRules) {
        if (rule.rule_type === 'conversation' &&
            rule.platform === message.platform &&
            rule.match_value === message.conversation_id) {
          return rule.priority;
        }
      }
    }

    // 2. Pattern-based rules (sender, app, keyword, group)
    let wildcardResult: Priority | null = null;

    for (const rule of userRules) {
      const val = rule.match_value.toLowerCase();
      switch (rule.rule_type) {
        case 'sender':
          if (val === '*' || senderLower.includes(val)) return rule.priority;
          break;
        case 'app':
          if (val === '*' || appLower === val) return rule.priority;
          break;
        case 'app_direct':
          if ((val === '*' || appLower === val) && !message.is_group) return rule.priority;
          break;
        case 'app_group':
          if ((val === '*' || appLower === val) && message.is_group) return rule.priority;
          break;
        case 'keyword':
          if (bodyLower.includes(val)) return rule.priority;
          break;
        case 'group':
          if (message.is_group && (val === '*' || message.group_name?.toLowerCase().includes(val)))
            return rule.priority;
          break;
        case 'wildcard':
          wildcardResult = rule.priority;
          break;
        // 'conversation' already handled above
      }
    }

    // 3. Wildcard — lowest priority
    return wildcardResult;
  }

  /** Check if a conversation/person has media download enabled. */
  async shouldDownloadMedia(
    userId: string,
    platform: string,
    conversationId: string,
    isGroup: boolean,
    personId?: string | null,
  ): Promise<boolean> {
    // Check contact_settings first (new system)
    if (isGroup) {
      const groupSettings = await this.getContactSettings(userId, 'group', conversationId);
      if (groupSettings) return groupSettings.download_media;
    } else if (personId) {
      const personSettings = await this.getContactSettings(userId, 'person', personId);
      if (personSettings) return personSettings.download_media;
    }

    // Legacy fallback: check notification_rules
    await this.refresh();
    const userRules = this.rules.get(userId);
    if (!userRules) return false;

    for (const rule of userRules) {
      if (rule.rule_type === 'conversation' &&
          rule.platform === platform &&
          rule.match_value === conversationId) {
        return rule.download_images;
      }
    }
    return false;
  }

  /** @deprecated Use shouldDownloadMedia instead */
  async shouldDownloadImages(
    userId: string,
    platform: string,
    conversationId: string,
  ): Promise<boolean> {
    return this.shouldDownloadMedia(userId, platform, conversationId, true);
  }
}
