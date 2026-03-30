import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';

interface Rule {
  id: string;
  rule_type: string;
  match_value: string;
  priority: 'immediate' | 'batch' | 'ignore';
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
        'SELECT id, user_id, rule_type, match_value, priority FROM notification_rules',
      );
      this.rules.clear();
      for (const row of result.rows) {
        const list = this.rules.get(row.user_id) || [];
        list.push({
          id: row.id,
          rule_type: row.rule_type,
          match_value: row.match_value,
          priority: row.priority as 'immediate' | 'batch' | 'ignore',
        });
        this.rules.set(row.user_id, list);
      }
      this.lastRefresh = Date.now();
    } catch (err) {
      logger.warn('Failed to refresh notification rules', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    },
  ): Promise<'immediate' | 'batch' | 'ignore' | null> {
    await this.refresh();
    const userRules = this.rules.get(userId);
    if (!userRules || userRules.length === 0) return null;

    const senderLower = message.sender.toLowerCase();
    const bodyLower = message.body.toLowerCase();
    const appLower = message.app.toLowerCase();

    // Specific rules first, wildcard/catch-all last
    let wildcardResult: 'immediate' | 'batch' | 'ignore' | null = null;

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
      }
    }
    return wildcardResult;
  }
}
