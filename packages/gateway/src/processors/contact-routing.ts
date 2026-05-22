import type { Pool } from 'pg';
import { logger } from '../utils/logger.js';
import { isEscalated } from '../utils/escalation.js';

export type Priority = 'immediate' | 'batch' | 'ignore' | 'agent';

/**
 * Resolves message routing (Delivery) and media-download from contact_settings —
 * the single source of truth for all per-contact / per-chat communication settings.
 *
 * Group messages resolve by conversation_id (target_type='group'); 1:1 messages
 * resolve by the linked KB person_id (target_type='person'). An active escalation
 * overrides everything with 'immediate'.
 */
export class ContactRoutingResolver {
  constructor(private pool: Pool) {}

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
    // 0. Active escalation overrides all settings with 'immediate'.
    if (message.platform && message.conversation_id) {
      const escalated = await isEscalated(this.pool, userId, message.platform, message.conversation_id);
      if (escalated) {
        logger.debug('[ContactRoutingResolver][match] Escalation active, returning immediate', {
          platform: message.platform, conversationId: message.conversation_id,
        });
        return 'immediate';
      }
    }

    // 1. Contact settings — unified person/group routing.
    if (message.is_group && message.conversation_id) {
      const groupSettings = await this.getContactSettings(userId, 'group', message.conversation_id);
      if (groupSettings) return groupSettings.routing as Priority;
    } else if (!message.is_group && message.person_id) {
      const personSettings = await this.getContactSettings(userId, 'person', message.person_id);
      if (personSettings) return personSettings.routing as Priority;
    }

    // No matching setting — caller applies its default.
    return null;
  }

  /** Check if a conversation/person has media download enabled. */
  async shouldDownloadMedia(
    userId: string,
    _platform: string,
    conversationId: string,
    isGroup: boolean,
    personId?: string | null,
  ): Promise<boolean> {
    if (isGroup) {
      const groupSettings = await this.getContactSettings(userId, 'group', conversationId);
      return groupSettings?.download_media ?? false;
    }
    if (personId) {
      const personSettings = await this.getContactSettings(userId, 'person', personId);
      return personSettings?.download_media ?? false;
    }
    return false;
  }
}
