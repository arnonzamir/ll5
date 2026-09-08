/**
 * All-app notification processor (2026-09-08) — the phone forwards every
 * package's notifications through ONE generic capture (no per-connector
 * capture on the phone since 2026-09-08 evening, Arnon's decision); this file
 * is the single `app_notification` entry point and routes by package
 * (`routeAppNotification`, decision table in `decideNotificationRoute`):
 *
 *   - catalog connector package (`connectorForPackage`) with
 *     `data_sources.connector_<id>` enabled → handed to
 *     processors/connector-event.ts (parse → store → rules → ladder) AND, when
 *     `notifications_all` is on, stored here with `connector_id` set — it is
 *     still a notification the user saw;
 *   - catalog connector package with the connector disabled → a normal
 *     notification (stored here per routing, no parser);
 *   - IM package (`IM_PACKAGES`) → dropped: the `message` path carries it;
 *   - anything else → stored here under the `notifications_all` gate.
 *
 * The `notifications_all` gate applies only to the awareness store, never to
 * connector routing (a user who turned generic capture off on the phone sends
 * nothing anyway). Removals (`removed:true`) never reach the parser.
 *
 * Awareness stores, the agent queries (docs/purpose.md): one doc per
 * notification key in ll5_awareness_notifications, no notable event, and by
 * default NO system message — get_situation.recent_notifications and
 * query_notifications are how the agent sees them. Per-package routing in
 * user_settings.settings.notifications.routing { '<package>': ... }:
 *
 *   immediate  one system message `[Notification] <app>: <title> — <text>`,
 *              under the DECISION-034/ISS-033 cost guard: at most
 *              IMMEDIATE_MAX_PER_HOUR per package per hour, overflow coalesced
 *              into one burst (GroupCoalescer, 15 min / 12 items), then nothing
 *              more this hour (stored only). Ongoing notifications (media
 *              players, foreground services) and removals are never immediate.
 *   batch      stored only (default)
 *   ignore     not stored at all
 *
 * Dedupe: Android's notification `key` (else a hash of package + title + text +
 * post_time) → deterministic _id per (user, key); an update re-posts over the
 * same _id, a removal stamps removed_at on it. 30-day retention via
 * pruneOldNotifications (heartbeat new-day edge).
 */
import type { Client } from '@elastic/elasticsearch';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { connectorForPackage, type ConnectorCatalogEntry } from '@ll5/shared';
import type { PushAppNotificationItem } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { GroupCoalescer, type CoalescedItem } from '../utils/group-coalescer.js';
import { isSourceEnabled } from '../utils/data-source-config.js';
import { decide, newCostGuardState, noteBurstFlushed, type CostGuardState, type ImmediateDecision } from '../connectors/cost-guard.js';
import { processConnectorEvent } from './connector-event.js';

export type NotificationRouting = 'immediate' | 'batch' | 'ignore';
export type NotificationPackageClass = 'connector' | 'im' | 'app';

export const IMMEDIATE_MAX_PER_HOUR = 3;
export const NOTIFICATION_COALESCE_WINDOW_MS = 15 * 60_000;
export const NOTIFICATION_COALESCE_MAX_ITEMS = 12;
export const NOTIFICATION_RETENTION_DAYS = 30;
const IMMEDIATE_TEXT_MAX = 500;

/**
 * Packages whose notifications ARE the IM mirror (`message` items). An
 * app_notification from one of these is dropped: the message path already
 * carries it with sender/conversation identity, and storing it twice would
 * put every WhatsApp line into the notifications index too.
 */
export const IM_PACKAGES: ReadonlySet<string> = new Set([
  'com.whatsapp',
  'com.whatsapp.w4b',
  'org.telegram.messenger',
  'org.telegram.messenger.web',
  'org.thoughtcrime.securesms',
  'com.google.android.apps.messaging',
  'com.android.mms',
  'com.samsung.android.messaging',
  'com.Slack',
  'com.google.android.gm',
]);

/** Pure: which path an app_notification package takes in the gateway. */
export function classifyNotificationPackage(pkg: string): NotificationPackageClass {
  if (connectorForPackage(pkg)) return 'connector';
  if (IM_PACKAGES.has(pkg)) return 'im';
  return 'app';
}

export interface NotificationRouteInputs {
  /** `data_sources.connector_<id>.enabled` for the matched connector (ignored for non-connector packages). */
  connectorEnabled: boolean;
  /** `data_sources.notifications_all.enabled`. */
  notificationsAllEnabled: boolean;
  /** `removed:true` items are removal events — never parsed as a connector event. */
  removed?: boolean;
}

export interface NotificationRoute {
  class: NotificationPackageClass;
  /** Hand the item to processors/connector-event.ts (this connector). */
  connector: ConnectorCatalogEntry | null;
  /** Store in ll5_awareness_notifications (per-package routing still applies). */
  store: boolean;
  /** Stamped on the stored doc when the item was handed to the connector path. */
  connectorId: string | null;
}

/**
 * Pure: the routing decision table.
 *
 *   class      connector_<id>  notifications_all  → parser  store
 *   connector  on              on                   yes     yes (connector_id)
 *   connector  on              off                  yes     no
 *   connector  off             on                   no      yes
 *   connector  off             off                  no      no
 *   im         any             any                  no      no   (dropped)
 *   app        n/a             on                   no      yes
 *   app        n/a             off                  no      no
 *
 * A removal of a connector-package notification skips the parser row.
 */
export function decideNotificationRoute(pkg: string, inputs: NotificationRouteInputs): NotificationRoute {
  const cls = classifyNotificationPackage(pkg);
  if (cls === 'im') return { class: cls, connector: null, store: false, connectorId: null };
  const entry = cls === 'connector' ? connectorForPackage(pkg) ?? null : null;
  const toParser = !!entry && inputs.connectorEnabled && !inputs.removed;
  return {
    class: cls,
    connector: toParser ? entry : null,
    store: inputs.notificationsAllEnabled,
    connectorId: toParser ? entry!.id : null,
  };
}

/** Pure: the per-(user, notification) identity — Android's key, else a content hash. */
export function notificationDedupeKey(item: Pick<PushAppNotificationItem, 'package' | 'key' | 'title' | 'text' | 'post_time'>): string {
  if (item.key) return `${item.package}:${item.key}`;
  const h = crypto.createHash('sha256')
    .update(`${item.package}\n${item.title ?? ''}\n${item.text ?? ''}\n${item.post_time}`)
    .digest('hex')
    .slice(0, 24);
  return `${item.package}:h:${h}`;
}

/** Pure: deterministic ES _id so re-posts and removals land on one doc. */
export function notificationDocId(userId: string, dedupeKey: string): string {
  return crypto.createHash('sha256').update(`${userId}:${dedupeKey}`).digest('hex').slice(0, 32);
}

/** Pure: routing for a package from the settings map; unknown/invalid → batch. */
export function resolveNotificationRouting(routing: Record<string, unknown> | null | undefined, pkg: string): NotificationRouting {
  const v = routing?.[pkg];
  return v === 'immediate' || v === 'ignore' ? v : 'batch';
}

export interface NotificationDoc {
  user_id: string;
  package: string;
  app_label: string | null;
  title: string | null;
  text: string | null;
  big_text: string | null;
  category: string | null;
  channel_id: string | null;
  ongoing: boolean;
  key: string | null;
  posted_at: string;
  received_at: string;
  removed_at: string | null;
  dedupe_key: string;
  /** Catalog connector id when the same notification was handed to the connector parser; null otherwise. */
  connector_id: string | null;
}

/** Pure: the stored document for a posted notification. */
export function buildNotificationDoc(userId: string, item: PushAppNotificationItem, receivedAt: string, connectorId: string | null = null): NotificationDoc {
  return {
    user_id: userId,
    package: item.package,
    app_label: item.app_label ?? null,
    title: item.title,
    text: item.text,
    big_text: item.big_text,
    category: item.category ?? null,
    channel_id: item.channel_id ?? null,
    ongoing: !!item.ongoing,
    key: item.key ?? null,
    posted_at: item.when ?? item.post_time,
    received_at: receivedAt,
    removed_at: null,
    dedupe_key: notificationDedupeKey(item),
    connector_id: connectorId,
  };
}

/** Pure: `[Notification] <app>: <title> — <text>`; title/text may each be absent. */
export function renderImmediateNotification(item: Pick<PushAppNotificationItem, 'package' | 'app_label' | 'title' | 'text'>): string {
  const label = item.app_label?.trim() || item.package;
  const title = item.title?.trim() ?? '';
  let text = item.text?.trim() ?? '';
  if (text.length > IMMEDIATE_TEXT_MAX) text = `${text.slice(0, IMMEDIATE_TEXT_MAX)}…`;
  const body = title && text ? `${title} — ${text}` : title || text || '(no text)';
  return `[Notification] ${label}: ${body}`;
}

export type NotificationDelivery = 'skip' | 'store' | 'system_message' | 'coalesce';

/**
 * Pure: what happens to this notification. `guard` is the per-(user, package)
 * cost-guard state and is mutated only when the routing is immediate and the
 * notification is deliverable (posted, not ongoing).
 */
export function decideNotificationDelivery(
  routing: NotificationRouting,
  item: Pick<PushAppNotificationItem, 'removed' | 'ongoing'>,
  guard: CostGuardState,
  now: number,
): NotificationDelivery {
  if (routing === 'ignore') return 'skip';
  if (routing === 'batch' || item.removed || item.ongoing) return 'store';
  const d: ImmediateDecision = decide(guard, now, IMMEDIATE_MAX_PER_HOUR);
  return d === 'immediate' ? 'system_message' : d === 'coalesce' ? 'coalesce' : 'store';
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const guards = new Map<string, CostGuardState>();
function guardFor(userId: string, pkg: string, now: number): CostGuardState {
  const key = `${userId}:notification:${pkg}`;
  let s = guards.get(key);
  if (!s) { s = newCostGuardState(now); guards.set(key, s); }
  return s;
}

interface RoutingCache { routing: Record<string, unknown>; ts: number }
const ROUTING_CACHE_TTL = 60_000;
const routingCache = new Map<string, RoutingCache>();

/** user_settings.settings.notifications.routing (60 s cache; {} on any failure). */
export async function readNotificationRouting(pool: Pool, userId: string, now = Date.now()): Promise<Record<string, unknown>> {
  const cached = routingCache.get(userId);
  if (cached && now - cached.ts < ROUTING_CACHE_TTL) return cached.routing;
  try {
    const r = await pool.query<{ routing: Record<string, unknown> | null }>(
      "SELECT settings->'notifications'->'routing' AS routing FROM user_settings WHERE user_id = $1",
      [userId],
    );
    const routing = r.rows[0]?.routing && typeof r.rows[0].routing === 'object' ? r.rows[0].routing : {};
    routingCache.set(userId, { routing, ts: now });
    return routing;
  } catch (err) {
    logger.warn('[app-notification][routing] settings read failed, defaulting to batch', {
      userId, error: err instanceof Error ? err.message : String(err),
    });
    return {};
  }
}

interface BurstMeta { pool: Pool; userId: string; pkg: string; label: string }
let coalescer: GroupCoalescer<BurstMeta> | null = null;
function getCoalescer(): GroupCoalescer<BurstMeta> {
  if (!coalescer) {
    coalescer = new GroupCoalescer<BurstMeta>({
      onFlush: deliverBurst,
      windowMs: NOTIFICATION_COALESCE_WINDOW_MS,
      maxItems: NOTIFICATION_COALESCE_MAX_ITEMS,
      onError: (err, key, n) => logger.error('[app-notification][burst] flush failed', { key, items: n, error: err instanceof Error ? err.message : String(err) }),
    });
  }
  return coalescer;
}

/** Pure: the burst body for coalesced immediates. */
export function renderNotificationBurst(label: string, items: CoalescedItem[]): string {
  const lines = items.map((it) => `- ${it.text}`);
  return `[Notification] ${label}: ${items.length} notifications in the last ${Math.round(NOTIFICATION_COALESCE_WINDOW_MS / 60_000)} min (rate cap reached):\n${lines.join('\n')}`;
}

async function deliverBurst(key: string, meta: BurstMeta, items: CoalescedItem[]): Promise<void> {
  if (items.length === 0) return;
  await insertSystemMessage(meta.pool, meta.userId, renderNotificationBurst(meta.label, items), undefined, createSchedulerEvent('app_notification'));
  noteBurstFlushed(guardFor(meta.userId, meta.pkg, Date.now()), Date.now());
  logger.info('[app-notification][burst] delivered', { key, items: items.length });
}

/** Flush open burst windows (tests / shutdown). */
export function flushNotificationBursts(): Promise<void> { return coalescer?.flushAll() ?? Promise.resolve(); }

/** Test hook. */
export function resetAppNotificationState(): void {
  guards.clear(); routingCache.clear(); coalescer = null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const NOTIFICATIONS_INDEX = 'll5_awareness_notifications';

export type NotificationRouteOutcome = 'dropped' | 'skipped' | 'stored' | 'connector' | 'connector+stored';

/**
 * THE `app_notification` entry point (server.ts calls only this). Reads the
 * two gates, decides (pure), then: awareness store first (idempotent by _id),
 * connector path second — a connector failure propagates so the phone retries
 * the item, and the re-store lands on the same doc.
 */
export async function routeAppNotification(
  es: Client,
  pool: Pool | undefined,
  userId: string,
  item: PushAppNotificationItem,
  now = Date.now(),
): Promise<NotificationRouteOutcome> {
  const cls = classifyNotificationPackage(item.package);
  if (cls === 'im') {
    logger.debug('[app-notification][route] IM package, carried by the message path — dropped', { package: item.package });
    return 'dropped';
  }
  const entry = cls === 'connector' ? connectorForPackage(item.package) : undefined;
  // Without a pool there is no connector path (it needs Postgres) and no gate
  // to read: the awareness store defaults to enabled, as isSourceEnabled does.
  const [connectorEnabled, notificationsAllEnabled] = await Promise.all([
    entry && pool ? isSourceEnabled(pool, userId, `connector_${entry.id}`) : Promise.resolve(false),
    pool ? isSourceEnabled(pool, userId, 'notifications_all') : Promise.resolve(true),
  ]);
  const route = decideNotificationRoute(item.package, { connectorEnabled, notificationsAllEnabled, removed: !!item.removed });

  if (route.store) {
    await processAppNotification(es, pool, userId, item, now, route.connectorId);
  }
  if (route.connector && pool) {
    await processConnectorEvent(es, pool, userId, route.connector, {
      connector_id: route.connector.id,
      package: item.package,
      sender: null,
      title: item.title,
      text: item.text,
      big_text: item.big_text,
      post_time: item.post_time,
    });
  }
  const outcome: NotificationRouteOutcome = route.connector && route.store ? 'connector+stored'
    : route.connector ? 'connector'
    : route.store ? 'stored'
    : 'skipped';
  logger.debug('[app-notification][route] decided', { package: item.package, class: route.class, outcome });
  return outcome;
}

export async function processAppNotification(
  es: Client,
  pool: Pool | undefined,
  userId: string,
  item: PushAppNotificationItem,
  now = Date.now(),
  connectorId: string | null = null,
): Promise<void> {
  const routingMap = pool ? await readNotificationRouting(pool, userId, now) : {};
  const routing = resolveNotificationRouting(routingMap, item.package);
  const delivery = decideNotificationDelivery(routing, item, guardFor(userId, item.package, now), now);
  if (delivery === 'skip') {
    logger.debug('[app-notification][routing] ignored package, not stored', { package: item.package });
    return;
  }

  const id = notificationDocId(userId, notificationDedupeKey(item));
  const receivedAt = new Date(now).toISOString();

  if (item.removed) {
    // A removal for a notification we never stored (posted before the source
    // was enabled, or pruned) is a no-op — never create a doc from a removal.
    try {
      await es.update({ index: NOTIFICATIONS_INDEX, id, doc: { removed_at: item.timestamp ?? receivedAt }, refresh: false });
    } catch (err) {
      const status = (err as { meta?: { statusCode?: number } }).meta?.statusCode;
      if (status !== 404) throw err;
    }
    return;
  }

  await es.index({ index: NOTIFICATIONS_INDEX, id, document: buildNotificationDoc(userId, item, receivedAt, connectorId), refresh: false });
  logger.debug('[app-notification][store] stored', { package: item.package, routing, delivery, ongoing: !!item.ongoing, connectorId });

  if (!pool || delivery === 'store') return;

  const line = renderImmediateNotification(item);
  const label = item.app_label?.trim() || item.package;
  if (delivery === 'system_message') {
    await insertSystemMessage(pool, userId, line, undefined, createSchedulerEvent('app_notification'));
    logger.info('[app-notification][immediate] system message', { package: item.package });
    return;
  }
  // coalesce
  getCoalescer().push(
    `${userId}:notification:${item.package}`,
    { pool, userId, pkg: item.package, label },
    { ts: now, sender: label, text: line.replace(/^\[Notification\] [^:]+: /, ''), mediaInfo: '', quotedInfo: '', fromMe: false },
  );
  logger.info('[app-notification][immediate] coalesced (rate cap)', { package: item.package });
}

/**
 * Retention: delete notifications received more than NOTIFICATION_RETENTION_DAYS
 * ago. Called once per local day from the heartbeat's new-day edge; best-effort.
 */
export async function pruneOldNotifications(es: Client, userId: string, now = Date.now()): Promise<number> {
  const cutoff = new Date(now - NOTIFICATION_RETENTION_DAYS * 86_400_000).toISOString();
  try {
    const r = await es.deleteByQuery({
      index: NOTIFICATIONS_INDEX,
      refresh: false,
      conflicts: 'proceed',
      query: { bool: { filter: [{ term: { user_id: userId } }, { range: { received_at: { lt: cutoff } } }] } },
    });
    const deleted = (r as { deleted?: number }).deleted ?? 0;
    if (deleted > 0) logger.info('[app-notification][prune] deleted old notifications', { userId, deleted, cutoff });
    return deleted;
  } catch (err) {
    logger.warn('[app-notification][prune] failed', { userId, error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}
