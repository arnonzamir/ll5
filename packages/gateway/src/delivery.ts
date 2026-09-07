import type { Pool } from 'pg';
import { logger } from './utils/logger.js';
import { sendFCMNotification } from './utils/fcm-sender.js';
import type { NotificationLevel } from './utils/fcm-sender.js';
import type { DeliveryMode } from './utils/delivery-mode.js';
import { getEffectiveTimezone } from './utils/timezone.js';
import { insertSystemMessage } from './utils/system-message.js';
import {
  LEVEL_BY_STAKES, MISS_GRACE_MS, fmtLocalHHMM, futureText, localHour, maxLevel, modalityForLevel,
  planRungs, timeLeftText,
} from './utils/delivery-contract.js';
import type { DeliveryBlock, DeliveryClass, Modality, PlannedRung, Rung, Stakes } from './utils/delivery-contract.js';

/**
 * Delivery contract — the database side (DECISION-034, Phase 1).
 *
 * `attachDelivery` runs after a classed chat row exists: it files the tray
 * `ask` (needs-you / do-by), writes the `message_delivery` record with the
 * modality chosen, and sends (or withholds, inside the quiet-hours hold) the
 * initial push. The tray routes and the escalation scheduler call the
 * smaller helpers below to move the record along.
 */

/** Shape of message_delivery.escalation. */
export interface EscalationState {
  spec: DeliveryBlock['escalation'];
  rungs: PlannedRung[];
  /** ISO instant of the next unsent rung, null when none. */
  next_at: string | null;
  /** ISO instant the ladder counts from (= max(send, quiet-hours end)). */
  ladder_start: string;
  /** 'held' while the quiet-hours hold withholds the initial push. */
  initial_push: 'sent' | 'held' | 'none';
}

export interface DeliveryRow {
  id: string;
  user_id: string;
  message_id: string;
  tray_item_id: string | null;
  class: DeliveryClass;
  subject: string | null;
  stakes: Stakes | null;
  due_at: Date | string | null;
  modality: Modality;
  delivery_mode: string | null;
  ack_required: boolean;
  status: 'sent' | 'acknowledged' | 'done' | 'expired' | 'missed';
  acknowledged_at: Date | string | null;
  done_at: Date | string | null;
  escalation: EscalationState | null;
  rung_sent: number;
  created_at: Date | string;
  content?: string | null;
}

export interface AttachDeliveryInput {
  userId: string;
  messageId: string;
  content: string;
  delivery: DeliveryBlock;
  /** The agent's own level — a floor under the stakes map. */
  notificationLevel?: NotificationLevel | null;
  deliveryMode: DeliveryMode | null;
  /** When set, the initial push is withheld and the ladder starts here. */
  holdUntil?: string | null;
  now?: Date;
}

export interface AttachDeliveryResult {
  delivery_id: string;
  tray_item_id: string | null;
  modality: Modality;
  level: NotificationLevel | null;
  push_held: boolean;
  future_text: string | null;
}

export interface PushArgs {
  userId: string;
  messageId: string;
  trayItemId: string | null;
  cls: DeliveryClass;
  subject: string | null;
  dueAt: string | null;
  rung: 'initial' | Rung;
  level: NotificationLevel;
  title: string;
  body: string;
}

/** True when the table is missing (pre-migration deploy). */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

/** FCM data must be flat strings. `collapse` = tray item id so ladder rungs
 *  replace the previous notification instead of stacking. */
export async function sendDeliveryPush(pool: Pool, args: PushArgs): Promise<void> {
  await sendFCMNotification(pool, args.userId, {
    title: args.title,
    body: args.body.length > 200 ? args.body.slice(0, 200) + '...' : args.body,
    type: 'agent_push',
    notification_level: args.level,
    data: {
      message_id: args.messageId,
      tray_item_id: args.trayItemId ?? '',
      class: args.cls,
      rung: args.rung,
      collapse: args.trayItemId ?? args.messageId,
      subject: args.subject ?? '',
      due_at: args.dueAt ?? '',
    },
  });
}

export function firstLine(text: string): string {
  return text.replace(/\r/g, '').trim().split('\n')[0]?.trim() ?? '';
}

/**
 * File the tray item + delivery record for a classed message and send the
 * initial push. Never throws on a missing table (the migration ships in the
 * same release) — logs and returns a chat-only result.
 */
export async function attachDelivery(pool: Pool, input: AttachDeliveryInput): Promise<AttachDeliveryResult | null> {
  const now = input.now ?? new Date();
  const { userId, messageId, content, delivery } = input;
  const isAsk = delivery.class !== 'fyi';
  const tz = await getEffectiveTimezone(pool, userId);

  // Level: the stakes map, with the agent's level as a floor. fyi keeps
  // today's behaviour (push only when the agent asked for a level).
  const level: NotificationLevel | null = isAsk
    ? maxLevel(LEVEL_BY_STAKES[delivery.stakes ?? 'medium'], input.notificationLevel)
    : (input.notificationLevel ?? null);
  const pushHeld = !!input.holdUntil && level !== 'critical';
  const modality: Modality = level ? modalityForLevel(level) : 'chat';

  const dueAt = delivery.due_at ? new Date(delivery.due_at) : null;
  const ladderStart = pushHeld && input.holdUntil ? new Date(Math.max(now.getTime(), Date.parse(input.holdUntil))) : now;
  const rungs = delivery.class === 'do-by' && dueAt ? planRungs(delivery.escalation, ladderStart, dueAt, delivery.stakes) : [];
  const escalation: EscalationState = {
    spec: delivery.escalation,
    rungs,
    next_at: rungs[0]?.at ?? null,
    ladder_start: ladderStart.toISOString(),
    initial_push: level ? (pushHeld ? 'held' : 'sent') : 'none',
  };
  const future = isAsk && dueAt ? futureText(delivery.class, rungs, 0, dueAt, tz) : null;

  let trayItemId: string | null = null;
  if (isAsk && dueAt) {
    try {
      const ins = await pool.query<{ id: string }>(
        `INSERT INTO tray_items
           (user_id, kind, question, context, options, subject, due_at, ack_required, message_id, escalation, future_text, source)
         VALUES ($1, 'ask', $2, $3, '[]'::jsonb, $2, $4, $5, $6, $7, $8, 'delivery')
         RETURNING id`,
        [userId, delivery.subject, firstLine(content), dueAt.toISOString(), delivery.ack_required, messageId, JSON.stringify(escalation), future],
      );
      trayItemId = ins.rows[0]?.id ?? null;
    } catch (err) {
      if (isMissingTable(err) || (err as { code?: string } | null)?.code === '42703') {
        logger.warn('[delivery][attach] tray_items not ready for asks (migration 049 pending) — chat only', { userId });
      } else {
        throw err;
      }
    }
  }

  let deliveryId: string | null = null;
  try {
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO message_delivery
         (user_id, message_id, tray_item_id, class, subject, stakes, due_at, modality, delivery_mode, hour_local,
          ack_required, status, escalation, rung_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'sent', $12, 0)
       RETURNING id`,
      [
        userId, messageId, trayItemId, delivery.class, delivery.subject, delivery.stakes,
        dueAt?.toISOString() ?? null, modality, input.deliveryMode, localHour(now, tz),
        delivery.ack_required, JSON.stringify(escalation),
      ],
    );
    deliveryId = ins.rows[0]?.id ?? null;
  } catch (err) {
    if (isMissingTable(err)) {
      logger.warn('[delivery][attach] message_delivery missing (migration 049 pending) — no delivery record', { userId });
      return null;
    }
    throw err;
  }

  if (level && !pushHeld) {
    sendDeliveryPush(pool, {
      userId, messageId, trayItemId, cls: delivery.class, subject: delivery.subject,
      dueAt: dueAt?.toISOString() ?? null, rung: 'initial', level,
      title: delivery.subject ?? 'LL5',
      body: content,
    }).catch((err) => logger.warn('[delivery][attach] FCM send failed', { error: err instanceof Error ? err.message : String(err) }));
  } else if (pushHeld) {
    logger.info('[delivery][attach] initial push held until quiet hours end', { userId, class: delivery.class, ladder_start: escalation.ladder_start });
  }

  return { delivery_id: deliveryId!, tray_item_id: trayItemId, modality, level, push_held: pushHeld, future_text: future };
}

/** Open (sent / acknowledged) deliveries with their message text, oldest due first. */
export async function listOpenDeliveries(pool: Pool, userId: string): Promise<DeliveryRow[]> {
  try {
    const r = await pool.query<DeliveryRow>(
      `SELECT d.id, d.user_id, d.message_id, d.tray_item_id, d.class, d.subject, d.stakes, d.due_at, d.modality,
              d.delivery_mode, d.ack_required, d.status, d.acknowledged_at, d.done_at, d.escalation, d.rung_sent,
              d.created_at, m.content
         FROM message_delivery d
         LEFT JOIN chat_messages m ON m.id = d.message_id
        WHERE d.user_id = $1 AND d.status IN ('sent', 'acknowledged')
        ORDER BY d.due_at ASC NULLS LAST, d.created_at ASC`,
      [userId],
    );
    return r.rows;
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

/**
 * Release the initial push of every do-by whose push was withheld by the
 * quiet-hours hold and whose ladder start has arrived. Idempotent: the
 * UPDATE's WHERE flips initial_push so a concurrent tick cannot double-send.
 * Returns the number pushed.
 */
export async function releaseHeldInitialPushes(pool: Pool, userId: string, now = new Date()): Promise<number> {
  let rows: DeliveryRow[];
  try {
    const r = await pool.query<DeliveryRow>(
      `UPDATE message_delivery d
          SET escalation = d.escalation || '{"initial_push":"sent"}'::jsonb
         FROM chat_messages m
        WHERE d.user_id = $1 AND d.status = 'sent'
          AND d.escalation->>'initial_push' = 'held'
          AND (d.escalation->>'ladder_start')::timestamptz <= $2
          AND m.id = d.message_id
        RETURNING d.id, d.user_id, d.message_id, d.tray_item_id, d.class, d.subject, d.stakes, d.due_at, d.modality,
                  d.delivery_mode, d.ack_required, d.status, d.acknowledged_at, d.done_at, d.escalation, d.rung_sent,
                  d.created_at, m.content`,
      [userId, now.toISOString()],
    );
    rows = r.rows;
  } catch (err) {
    if (isMissingTable(err)) return 0;
    throw err;
  }
  for (const d of rows) {
    const level = maxLevel(LEVEL_BY_STAKES[d.stakes ?? 'medium'], null);
    await sendDeliveryPush(pool, {
      userId, messageId: d.message_id, trayItemId: d.tray_item_id, cls: d.class, subject: d.subject,
      dueAt: d.due_at ? new Date(d.due_at).toISOString() : null, rung: 'initial', level,
      title: d.subject ?? 'LL5', body: d.content ?? d.subject ?? '',
    }).catch((err) => logger.warn('[delivery][releaseHeld] FCM send failed', { error: err instanceof Error ? err.message : String(err) }));
    logger.info('[delivery][releaseHeld] held initial push released', { userId, delivery_id: d.id, class: d.class, level });
  }
  return rows.length;
}

/**
 * Send one ladder rung and record it (rung_sent + sent_at on the plan +
 * next_at + the tray card's future_text). `reach` in Phase 1 is the FCM
 * rung only — see the TODO.
 */
export async function sendRung(pool: Pool, d: DeliveryRow, index: number, tz: string, now = new Date()): Promise<void> {
  const esc = d.escalation!;
  const rung = esc.rungs[index];
  const dueAt = d.due_at ? new Date(d.due_at) : null;
  const dueTxt = dueAt ? `due ${fmtLocalHHMM(dueAt, tz)} (${timeLeftText(dueAt, now)})` : '';
  const head = firstLine(d.content ?? d.subject ?? '');
  const body = rung.rung === 'reach'
    ? `Still open: ${d.subject ?? head} — ${dueTxt}. Tap Done or Got it.`
    : `${head}${dueTxt ? ` — ${dueTxt}` : ''}`;

  // Durable dedup first (the habit-scheduler pattern): a crash after the
  // UPDATE loses at most one push, never repeats one.
  const rungs = esc.rungs.map((r, i) => (i === index ? { ...r, sent_at: now.toISOString() } : r));
  const nextAt = rungs[index + 1]?.at ?? null;
  const upd = await pool.query(
    `UPDATE message_delivery
        SET rung_sent = $3, escalation = escalation || $4::jsonb,
            modality = CASE WHEN $5 = 'reach' THEN 'reach' WHEN $5 = 'alarm' THEN 'push_alarm' ELSE modality END
      WHERE id = $1 AND user_id = $2 AND status = 'sent' AND rung_sent = $6`,
    [d.id, d.user_id, index + 1, JSON.stringify({ rungs, next_at: nextAt }), rung.rung, index],
  );
  if (upd.rowCount === 0) return; // acknowledged or raced — nothing to send

  if (d.tray_item_id && dueAt) {
    await pool.query(
      `UPDATE tray_items SET escalation = $3, future_text = $4 WHERE id = $1 AND user_id = $2`,
      [d.tray_item_id, d.user_id, JSON.stringify({ ...esc, rungs, next_at: nextAt }), futureText(d.class, rungs, index + 1, dueAt, tz)],
    );
  }

  await sendDeliveryPush(pool, {
    userId: d.user_id, messageId: d.message_id, trayItemId: d.tray_item_id, cls: d.class, subject: d.subject,
    dueAt: dueAt?.toISOString() ?? null, rung: rung.rung, level: rung.level,
    title: d.subject ?? 'LL5', body,
  }).catch((err) => logger.warn('[delivery][sendRung] FCM send failed', { error: err instanceof Error ? err.message : String(err) }));

  if (rung.rung === 'reach') {
    // TODO(Phase 2, DECISION-034 #3): reach = a WhatsApp message to the user's
    // own number through the messaging MCP (`send_whatsapp` to the self JID,
    // a dedicated self-chat the phone treats as a real conversation). Phase 1
    // logs + sends the FCM `rung:'reach'` only.
    logger.warn('[delivery][sendRung] reach rung — FCM only in Phase 1 (self-WhatsApp lands in Phase 2)', {
      userId: d.user_id, delivery_id: d.id, subject: d.subject,
    });
  }
  logger.info('[delivery][sendRung] rung sent', { userId: d.user_id, delivery_id: d.id, rung: rung.rung, level: rung.level, index });
}

export type AskOutcome = 'acknowledged' | 'done';

export interface MarkAskResult {
  status: 'open' | 'acknowledged' | 'done' | 'expired';
  subject: string | null;
  changed: boolean;
}

/**
 * The one-tap tray answer: flip the ask (and its delivery record), stop the
 * ladder, tell the agent. Idempotent — a repeat tap returns the current
 * status and sends nothing. Returns null when the item is not the user's or
 * is not an ask.
 */
export async function markAsk(pool: Pool, userId: string, trayItemId: string, outcome: AskOutcome, now = new Date()): Promise<MarkAskResult | null> {
  const cur = await pool.query<{ id: string; status: string; subject: string | null; ack_required: boolean | null }>(
    `SELECT id, status, subject, ack_required FROM tray_items WHERE id = $1 AND user_id = $2 AND kind = 'ask'`,
    [trayItemId, userId],
  );
  const item = cur.rows[0];
  if (!item) return null;
  const status = item.status as MarkAskResult['status'];

  // Already at (or past) the requested state — nothing to do.
  if (status === 'done' || (outcome === 'acknowledged' && status === 'acknowledged') || status === 'expired' && outcome === 'acknowledged') {
    return { status, subject: item.subject, changed: false };
  }

  const upd = await pool.query<{ status: string }>(
    outcome === 'done'
      ? `UPDATE tray_items SET status = 'done', done_at = $3, acknowledged_at = COALESCE(acknowledged_at, $3)
          WHERE id = $1 AND user_id = $2 AND kind = 'ask' AND status IN ('open', 'acknowledged', 'expired') RETURNING status`
      : `UPDATE tray_items SET status = 'acknowledged', acknowledged_at = $3
          WHERE id = $1 AND user_id = $2 AND kind = 'ask' AND status = 'open' RETURNING status`,
    [trayItemId, userId, now.toISOString()],
  );
  if (upd.rowCount === 0) return { status, subject: item.subject, changed: false };

  try {
    await pool.query(
      outcome === 'done'
        ? `UPDATE message_delivery SET status = 'done', done_at = $3, acknowledged_at = COALESCE(acknowledged_at, $3),
                  escalation = COALESCE(escalation, '{}'::jsonb) || '{"next_at":null}'::jsonb
            WHERE tray_item_id = $1 AND user_id = $2`
        : `UPDATE message_delivery SET status = 'acknowledged', acknowledged_at = $3,
                  escalation = COALESCE(escalation, '{}'::jsonb) || '{"next_at":null}'::jsonb
            WHERE tray_item_id = $1 AND user_id = $2 AND status = 'sent'`,
      [trayItemId, userId, now.toISOString()],
    );
  } catch (err) {
    if (!isMissingTable(err)) throw err;
  }

  await insertSystemMessage(pool, userId, `[Tray] ${outcome}: ${item.subject ?? '(no subject)'}`);
  return { status: outcome, subject: item.subject, changed: true };
}

/**
 * Close an ask that outlived due_at + grace unacknowledged: do-by → missed,
 * needs-you → expired; the tray card expires; one `[Tray] missed:` line to
 * the agent. An acknowledged do-by that is never marked done just expires
 * from the tray silently (the user said "got it").
 */
export async function expireDelivery(pool: Pool, d: DeliveryRow, now = new Date()): Promise<void> {
  const unacknowledged = d.status === 'sent';
  const finalStatus = unacknowledged ? (d.class === 'do-by' ? 'missed' : 'expired') : d.status;
  if (unacknowledged) {
    const upd = await pool.query(
      `UPDATE message_delivery SET status = $3, escalation = COALESCE(escalation, '{}'::jsonb) || '{"next_at":null}'::jsonb
        WHERE id = $1 AND user_id = $2 AND status = 'sent'`,
      [d.id, d.user_id, finalStatus],
    );
    if (upd.rowCount === 0) return; // acknowledged meanwhile
  }
  if (d.tray_item_id) {
    await pool.query(
      `UPDATE tray_items SET status = 'expired' WHERE id = $1 AND user_id = $2 AND status IN ('open', 'acknowledged')`,
      [d.tray_item_id, d.user_id],
    );
  }
  if (unacknowledged) {
    await insertSystemMessage(pool, d.user_id, `[Tray] missed: ${d.subject ?? '(no subject)'}`);
    logger.info('[delivery][expire] ask closed unacknowledged', { userId: d.user_id, delivery_id: d.id, class: d.class, status: finalStatus, at: now.toISOString() });
  }
}

export function isPastGrace(d: DeliveryRow, now: Date): boolean {
  if (!d.due_at) return false;
  return new Date(d.due_at).getTime() + MISS_GRACE_MS <= now.getTime();
}
