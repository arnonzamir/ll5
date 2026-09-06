/**
 * Connector event processor — phone notification / SMS from a catalog
 * connector → parse → store in the connectors MCP → rules → trigger ladder
 * (docs/design/connectors.md, Sections 2, 6, 8).
 *
 * Ladder, per event:
 *   1. `parse()` (pure). null = nothing to store.
 *   2. POST /api/events on the connectors MCP. `created:false` = duplicate
 *      dedupe_key → stop. Unreachable = log at error, raise `connector.ingest`
 *      (warning), and CONTINUE: the phone event must not be lost, so the rules
 *      and the ladder still run on the parsed event; the alert clears on the
 *      next successful POST.
 *   3. `evaluate()` (pure) with thresholds from user settings, known merchants
 *      (in-memory MerchantMemory + settings.known_merchants), recent events
 *      (in-memory, 1 h), delivery mode and at-home state.
 *   4. Rule hit → cost guard: 'immediate' = one system message
 *      (`[Card] 214 ILS at <merchant> 12:31 — unknown merchant`, the only place
 *      merchant text reaches the agent), `notify` high only for asleep_at_home;
 *      'coalesce' = into the per-connector GroupCoalescer (15 min / 12 items,
 *      one burst message); 'digest_only' = nothing immediate.
 *   5. Every event → writeNotableEvent (connector_finding when a rule hit,
 *      else connector_event) with a summary WITHOUT merchant text.
 *   6. `connector.fanout` (warning) once a connector passes 10 immediate
 *      messages in a day.
 */
import type { Client } from '@elastic/elasticsearch';
import type { Pool } from 'pg';
import type { ConnectorCatalogEntry, ConnectorEventInput } from '@ll5/shared';
import { logger } from '../utils/logger.js';
import { insertSystemMessage, createSchedulerEvent } from '../utils/system-message.js';
import { GroupCoalescer, type CoalescedItem } from '../utils/group-coalescer.js';
import { writeNotableEvent } from './notable.js';
import { computeDeliveryMode } from '../utils/delivery-mode.js';
import { getEffectiveTimezone } from '../utils/timezone.js';
import { getLocationState } from './location.js';
import { raiseAlert, clearAlert } from '../utils/alerting.js';
import { parse, type ParserInput } from '../connectors/parsers/index.js';
import { evaluate, merchantKey, type RecentEvent, type RuleHit } from '../connectors/rules.js';
import { MerchantMemory } from '../connectors/merchant-memory.js';
import { ConnectorCostGuard, DEFAULT_IMMEDIATE_MAX_PER_HOUR, FANOUT_ALERT_PER_DAY } from '../connectors/cost-guard.js';
import { recordConnectorEvent } from '../connectors/liveness.js';
import { readConnectorRuleSettings } from '../connectors/settings.js';
import { createConnectorsClient, type ConnectorsClient } from '../connectors/client.js';

export const CONNECTOR_COALESCE_WINDOW_MS = 15 * 60_000;
export const CONNECTOR_COALESCE_MAX_ITEMS = 12;
const RECENT_WINDOW_MS = 60 * 60_000;
const RECENT_MAX = 100;

// ---------------------------------------------------------------------------
// Module state (per process; battery-alert.ts idiom)
// ---------------------------------------------------------------------------

function maxPerHour(): number {
  const n = Number(process.env.CONNECTOR_IMMEDIATE_MAX_PER_HOUR);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_IMMEDIATE_MAX_PER_HOUR;
}

const costGuard = new ConnectorCostGuard(maxPerHour());
const merchants = new MerchantMemory();
const recentByUser = new Map<string, RecentEvent[]>();
/** Whether the last POST to the connectors MCP failed (drives clearAlert on recovery without a DB hit per event). */
const ingestFailing = new Set<string>();
let client: ConnectorsClient | null = null;
function getClient(): ConnectorsClient { return (client ??= createConnectorsClient()); }

interface BurstMeta { pool: Pool; userId: string; connector: ConnectorCatalogEntry; label: string; }
let coalescer: GroupCoalescer<BurstMeta> | null = null;
function getCoalescer(): GroupCoalescer<BurstMeta> {
  if (!coalescer) {
    coalescer = new GroupCoalescer<BurstMeta>({
      onFlush: deliverBurst,
      windowMs: CONNECTOR_COALESCE_WINDOW_MS,
      maxItems: CONNECTOR_COALESCE_MAX_ITEMS,
      onError: (err, key, n) => logger.error('[connector-event][burst] flush failed', { key, items: n, error: err instanceof Error ? err.message : String(err) }),
    });
  }
  return coalescer;
}

async function deliverBurst(key: string, meta: BurstMeta, items: CoalescedItem[]): Promise<void> {
  if (items.length === 0) return;
  const lines = items.map((it) => `- ${it.text}`);
  const body = `${meta.label} ${meta.connector.label}: ${items.length} flagged charges in the last ${Math.round(CONNECTOR_COALESCE_WINDOW_MS / 60_000)} min (rate cap reached):\n${lines.join('\n')}`;
  await insertSystemMessage(meta.pool, meta.userId, body, undefined, createSchedulerEvent('connector_rule'));
  costGuard.noteBurstFlushed(meta.userId, meta.connector.id);
  logger.info('[connector-event][burst] delivered', { key, items: items.length });
}

/** Flush open burst windows (tests / shutdown). */
export function flushConnectorBursts(): Promise<void> { return coalescer?.flushAll() ?? Promise.resolve(); }

/** Admin snapshot: cost-guard counters per user:connector. */
export function getConnectorCostGuardStats() { return costGuard.stats(); }

/** Test hook. */
export function resetConnectorEventState(): void {
  costGuard.reset(); merchants.reset(); recentByUser.clear(); ingestFailing.clear(); client = null; coalescer = null;
}

// ---------------------------------------------------------------------------
// Rendering (no merchant text outside the immediate message)
// ---------------------------------------------------------------------------

function connectorLabel(c: ConnectorCatalogEntry): string {
  if (c.id === 'bank') return '[Bank]';
  if (c.sensitivity === 'financial') return '[Card]';
  return `[${c.label}]`;
}

function fmtAmount(ev: ConnectorEventInput): string {
  if (typeof ev.amount !== 'number') return 'amount unknown';
  const n = Number.isInteger(ev.amount) ? String(ev.amount) : ev.amount.toFixed(2);
  return `${n} ${ev.currency ?? 'ILS'}`;
}

function fmtTime(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
  } catch {
    return iso.slice(11, 16);
  }
}

/** The agent-facing line: `[Card] 214 ILS at SUPER PHARM 12:31 — unknown merchant, foreign`. Merchant appears here only. */
export function renderImmediate(label: string, ev: ConnectorEventInput, hits: RuleHit[], tz: string): string {
  const at = ev.merchant ? ` at ${ev.merchant}` : '';
  const card = ev.account_ref ? ` (card ${ev.account_ref})` : '';
  return `${label} ${fmtAmount(ev)}${at} ${fmtTime(ev.occurred_at, tz)}${card} — ${hits.map((h) => h.detail).join(', ')}`;
}

/** Notable-event summary: amount + connector + kind, never the merchant. */
export function renderSummary(c: ConnectorCatalogEntry, ev: ConnectorEventInput, hits: RuleHit[]): string {
  const base = `${c.label}: ${ev.kind}${typeof ev.amount === 'number' ? ` ${fmtAmount(ev)}` : ''}${ev.foreign ? ' (foreign)' : ''}`;
  return hits.length ? `${base} — ${hits.map((h) => h.rule).join(', ')}` : base;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function processConnectorEvent(
  es: Client,
  pool: Pool,
  userId: string,
  connector: ConnectorCatalogEntry,
  input: ParserInput,
): Promise<void> {
  recordConnectorEvent(userId, connector.id);

  const event = parse(input);
  if (!event) {
    logger.debug('[connector-event][parse] empty notification, nothing to store', { connector: connector.id });
    return;
  }

  // 2. Store (idempotent on dedupe_key). Failure is loud but not fatal.
  let stored = false;
  try {
    const ack = await getClient().postEvent(userId, event);
    stored = true;
    if (ingestFailing.delete(userId)) {
      await clearAlert(pool, userId, 'connector.ingest');
    }
    if (!ack.created) {
      logger.info('[connector-event][store] duplicate dedupe_key, skipping', { connector: connector.id, id: ack.id });
      return;
    }
    event.payload.event_id = ack.id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[connector-event][store] connectors MCP unreachable — running rules on the unstored event', {
      connector: connector.id, kind: event.kind, error: message,
    });
    ingestFailing.add(userId);
    await raiseAlert(pool, {
      userId, key: 'connector.ingest', severity: 'warning',
      summary: 'Connector event ingest failing',
      value: message.slice(0, 160),
      expected: 'POST /api/events 2xx',
      suggestion: `The connectors MCP at ${getClient().baseUrl} did not accept an event; check the connectors service / CONNECTORS_MCP_URL. Events still reach the agent, but are not stored until it recovers.`,
    });
  }

  // 3. Rules (charges only; everything else is stored + notable and stops there).
  const now = Date.now();
  const key = merchantKey(event.merchant);
  let hits: RuleHit[] = [];
  let tz = 'Asia/Jerusalem';
  if (event.kind === 'charge') {
    const settings = await readConnectorRuleSettings(pool, userId);
    const known = merchants.knownKeys(userId, now);
    for (const k of settings.knownMerchantKeys) known.add(k);
    tz = await getEffectiveTimezone(pool, userId).catch(() => tz);
    const [mode, loc] = await Promise.all([
      computeDeliveryMode(pool, es, userId, tz).catch(() => null),
      getLocationState(es, userId).catch(() => null),
    ]);
    const atHome = !!loc && loc.kind === 'place' && loc.label.trim().toLowerCase() === 'home';
    hits = evaluate(event, {
      thresholds: settings.thresholds,
      knownMerchantKeys: known,
      recentEvents: recent(userId, now),
      deliveryMode: mode?.mode ?? 'normal',
      atHome,
    });
    event.rule_hits = hits.map((h) => h.rule);
  }
  // Learn AFTER evaluating: the first sighting is the unknown one.
  merchants.note(userId, key, now);
  pushRecent(userId, { merchantKey: key, amount: event.amount ?? null, currency: event.currency ?? null, occurred_at: event.occurred_at }, now);

  // 4. Trigger ladder.
  if (hits.length > 0) {
    const label = connectorLabel(connector);
    const line = renderImmediate(label, event, hits, tz);
    const decision = costGuard.decide(userId, connector.id, now);
    if (decision === 'immediate') {
      const asleep = hits.some((h) => h.rule === 'asleep_at_home');
      await insertSystemMessage(
        pool, userId, line,
        asleep ? { title: `${connector.label}: card used while you sleep`, type: 'connector_rule', priority: 'high' } : undefined,
        createSchedulerEvent('connector_rule'),
      );
    } else if (decision === 'coalesce') {
      getCoalescer().push(
        ConnectorCostGuard.key(userId, connector.id),
        { pool, userId, connector, label },
        { ts: now, sender: connector.label, text: line, mediaInfo: '', quotedInfo: '', fromMe: false },
      );
    }
    logger.info('[connector-event][rules] hit', { connector: connector.id, rules: event.rule_hits, decision, stored });

    const today = costGuard.immediateToday(userId, connector.id, now);
    if (today > FANOUT_ALERT_PER_DAY) {
      await raiseAlert(pool, {
        userId, key: 'connector.fanout', severity: 'warning',
        summary: `Connector ${connector.id} fan-out high`,
        value: `${today} immediate messages today`,
        expected: `<= ${FANOUT_ALERT_PER_DAY}/day`,
        suggestion: 'A connector is waking the agent too often — raise its thresholds in settings.connectors.rules or lower CONNECTOR_IMMEDIATE_MAX_PER_HOUR.',
      });
    }
  }

  // 5. Notable event for every stored/parsed event — summary carries no merchant text.
  await writeNotableEvent(es, userId, {
    event_type: hits.length ? 'connector_finding' : 'connector_event',
    timestamp: event.occurred_at,
    summary: renderSummary(connector, event, hits),
    severity: hits.some((h) => h.rule === 'asleep_at_home') ? 'high' : hits.length ? 'medium' : 'low',
    payload: {
      connector_id: connector.id,
      kind: event.kind,
      amount: event.amount ?? null,
      currency: event.currency ?? null,
      foreign: !!event.foreign,
      account_ref: event.account_ref ?? null,
      rule_hits: event.rule_hits ?? [],
      event_id: event.payload.event_id ?? null,
      stored,
    },
  });
}

function recent(userId: string, now: number): RecentEvent[] {
  const list = recentByUser.get(userId) ?? [];
  const kept = list.filter((r) => now - Date.parse(r.occurred_at) <= RECENT_WINDOW_MS);
  recentByUser.set(userId, kept);
  return kept;
}

function pushRecent(userId: string, r: RecentEvent, now: number): void {
  const list = recent(userId, now);
  list.push(r);
  if (list.length > RECENT_MAX) list.splice(0, list.length - RECENT_MAX);
}
