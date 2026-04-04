import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { insertSystemMessage } from './system-message.js';

export interface Escalation {
  id: string;
  platform: string;
  conversation_id: string;
  conversation_name: string;
  original_priority: string;
  started_at: string;
  expires_at: string;
}

const ESCALATION_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check if a conversation is currently escalated.
 */
export async function isEscalated(
  pool: Pool,
  userId: string,
  platform: string,
  conversationId: string,
): Promise<boolean> {
  try {
    const result = await pool.query(
      "SELECT settings->'active_escalations' as esc FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const escalations: Escalation[] = result.rows[0]?.esc ?? [];
    const now = new Date().toISOString();
    return escalations.some(
      (e) => e.platform === platform && e.conversation_id === conversationId && e.expires_at > now,
    );
  } catch {
    return false;
  }
}

/**
 * Create or extend an escalation for a conversation.
 * If already escalated, extends the timer. If new, creates escalation + notifies agent.
 */
export async function escalateConversation(
  pool: Pool,
  es: Client,
  userId: string,
  platform: string,
  conversationId: string,
  conversationName: string,
  originalPriority: string,
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ESCALATION_DURATION_MS).toISOString();

  try {
    // Read current escalations
    const result = await pool.query(
      "SELECT settings->'active_escalations' as esc FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const escalations: Escalation[] = result.rows[0]?.esc ?? [];

    const existing = escalations.find(
      (e) => e.platform === platform && e.conversation_id === conversationId,
    );

    if (existing) {
      // Extend the timer
      existing.expires_at = expiresAt;
      await pool.query(
        `UPDATE user_settings SET settings = jsonb_set(settings, '{active_escalations}', $2::jsonb), updated_at = now() WHERE user_id = $1`,
        [userId, JSON.stringify(escalations)],
      );
      logger.info('[escalation][extend] Escalation extended', { platform, conversationId, expiresAt });
      return;
    }

    // New escalation
    const escalation: Escalation = {
      id: `esc_${crypto.randomBytes(6).toString('hex')}`,
      platform,
      conversation_id: conversationId,
      conversation_name: conversationName,
      original_priority: originalPriority,
      started_at: now.toISOString(),
      expires_at: expiresAt,
    };

    escalations.push(escalation);

    await pool.query(
      `INSERT INTO user_settings (user_id, settings, updated_at)
       VALUES ($1, jsonb_build_object('active_escalations', $2::jsonb), now())
       ON CONFLICT (user_id) DO UPDATE SET
         settings = jsonb_set(user_settings.settings, '{active_escalations}', $2::jsonb),
         updated_at = now()`,
      [userId, JSON.stringify(escalations)],
    );

    // Fetch recent messages for context
    const recentMessages = await fetchRecentMessages(es, userId, platform, conversationId);
    const contextBlock = recentMessages.length > 0
      ? `\nRecent messages:\n${recentMessages.map((m) => `- ${m.sender}: ${m.content}`).join('\n')}`
      : '';

    // Notify agent
    await insertSystemMessage(
      pool,
      userId,
      `[Escalation] You sent a message in "${conversationName}" (${platform}). ` +
      `This conversation is normally "${originalPriority}". ` +
      `Temporarily elevated to immediate for 30 minutes (ID: ${escalation.id}).` +
      `${contextBlock}\n\n` +
      `You will be notified when the window expires. You must then decide whether to change this conversation's priority permanently.`,
    );

    logger.info('[escalation][create] Escalation created', {
      id: escalation.id,
      platform,
      conversationId,
      conversationName,
      originalPriority,
    });
  } catch (err) {
    logger.error('[escalation][create] Failed to create escalation', {
      error: err instanceof Error ? err.message : String(err),
      platform,
      conversationId,
    });
  }
}

/**
 * Check for expired escalations and send expiry notifications.
 * Called periodically (every 60 seconds).
 */
export async function checkExpiredEscalations(pool: Pool): Promise<void> {
  try {
    // Find all users with active escalations
    const result = await pool.query(
      "SELECT user_id, settings->'active_escalations' as esc FROM user_settings WHERE settings->'active_escalations' IS NOT NULL AND jsonb_array_length(settings->'active_escalations') > 0",
    );

    const now = new Date().toISOString();

    for (const row of result.rows) {
      const userId = row.user_id;
      const escalations: Escalation[] = row.esc ?? [];
      const expired = escalations.filter((e) => e.expires_at <= now);
      const remaining = escalations.filter((e) => e.expires_at > now);

      if (expired.length === 0) continue;

      // Update: keep only non-expired
      await pool.query(
        `UPDATE user_settings SET settings = jsonb_set(settings, '{active_escalations}', $2::jsonb), updated_at = now() WHERE user_id = $1`,
        [userId, JSON.stringify(remaining)],
      );

      // Send expiry notice for each
      for (const esc of expired) {
        await insertSystemMessage(
          pool,
          userId,
          `[Escalation Expiring] Your 30-minute attention window for "${esc.conversation_name}" (${esc.platform}) has ended (ID: ${esc.id}). ` +
          `Original priority: ${esc.original_priority}.\n\n` +
          `You MUST now decide: should this conversation's routing priority change, or revert to "${esc.original_priority}"?\n` +
          `Journal your reasoning — what was discussed, why you engaged, and your decision.`,
        );

        logger.info('[escalation][expire] Escalation expired', {
          id: esc.id,
          platform: esc.platform,
          conversationId: esc.conversation_id,
          conversationName: esc.conversation_name,
        });
      }
    }
  } catch (err) {
    logger.error('[escalation][checkExpired] Failed to check expired escalations', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Fetch recent messages from a conversation for escalation context.
 */
async function fetchRecentMessages(
  es: Client,
  userId: string,
  platform: string,
  conversationId: string,
  limit = 10,
): Promise<Array<{ sender: string; content: string; timestamp: string }>> {
  try {
    const result = await es.search({
      index: 'll5_awareness_messages',
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            { term: { app: platform } },
          ],
          should: [
            // Match by group_name (for groups) or sender context
            { term: { group_name: conversationId } },
          ],
          minimum_should_match: 0,
        },
      },
      size: limit,
      sort: [{ timestamp: 'desc' }],
      _source: ['sender', 'content', 'timestamp'],
    });

    return result.hits.hits.map((h) => {
      const s = h._source as Record<string, unknown>;
      return {
        sender: (s.sender as string) ?? '',
        content: ((s.content as string) ?? '').slice(0, 200),
        timestamp: (s.timestamp as string) ?? '',
      };
    }).reverse();
  } catch (err) {
    logger.warn('[escalation][fetchRecentMessages] Failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
