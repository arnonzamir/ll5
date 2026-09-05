import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import type { Client } from '@elastic/elasticsearch';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chatAuthMiddleware } from './chat.js';
import { insertSystemMessage, createSchedulerEvent } from './utils/system-message.js';
import { getEffectiveTimezone } from './utils/timezone.js';
import { logger } from './utils/logger.js';

const MCP_TIMEOUT_MS = 8000;
const SUBJECT_KINDS = ['person', 'place', 'group', 'topic'] as const;

// ---------------------------------------------------------------------------
// Topics "now" ranking (android-companion-ui interaction model §4 — FROZEN).
//
// sort=now re-ranks the knowledge MCP's relevance-sorted actives IN THE
// GATEWAY with a blend where volume is deliberately NOT a factor (chatty
// groups must not outrank a quiet thread where the user owes an answer):
//
//   score = 0.35·open_loop + 0.30·calendar_proximity + 0.25·recency + 0.10·status
//
// Every item gains `why_now` — exactly ONE signal per row, open-loop wins
// over calendar when both fire (the rail renders one glyph, never two).
// ---------------------------------------------------------------------------

/** How many actives to pull from the MCP before re-ranking (frozen contract). */
const NOW_FETCH_LIMIT = 25;
/** Recency half-life: 3 days (matches the MCP's own soft half-life). */
const RECENCY_HALF_LIFE_HOURS = 72;
/** Calendar-proximity lookahead window. */
const CAL_WINDOW_HOURS = 48;
/** Only name tokens of at least this many chars can match a calendar event. */
const MIN_TOKEN_LEN = 3;
/** why_now open-loop detail cap. */
const DETAIL_MAX = 60;
const CALENDAR_INDEX = 'll5_awareness_calendar_events';

export interface WhyNow {
  kind: 'open_loop' | 'calendar' | null;
  detail: string | null;
}

/** The narrative fields the ranking reads (list items come camelCase from the MCP). */
export interface NowRankableNarrative {
  title?: string;
  status?: string;
  openThreads?: string[];
  participants?: string[];
  lastObservedAt?: string;
  firstObservedAt?: string;
  [key: string]: unknown;
}

export interface CalendarEventLite {
  title: string;
  attendees: string[];
  /** Event start, ms epoch. */
  startMs: number;
}

/** Lowercased name tokens (≥3 chars) from the narrative title + participant names. */
function nameTokens(n: NowRankableNarrative): string[] {
  const tokens = new Set<string>();
  for (const source of [n.title ?? '', ...(n.participants ?? [])]) {
    for (const t of String(source).toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (t.length >= MIN_TOKEN_LEN) tokens.add(t);
    }
  }
  return [...tokens];
}

/**
 * Calendar proximity: 1.0 / 0.7 / 0.4 when an event in the next ≤12h / ≤24h /
 * ≤48h has a title or attendee containing any narrative name token
 * (case-insensitive substring). Earliest matching event wins (it is both the
 * closest and the one worth naming in why_now).
 */
export function calendarProximity(
  n: NowRankableNarrative,
  events: CalendarEventLite[],
  nowMs: number,
): { scale: number; startMs: number } | null {
  const tokens = nameTokens(n);
  if (tokens.length === 0) return null;
  const upcoming = [...events].sort((a, b) => a.startMs - b.startMs);
  for (const ev of upcoming) {
    const hoursAway = (ev.startMs - nowMs) / 3_600_000;
    if (hoursAway < 0 || hoursAway > CAL_WINDOW_HOURS) continue;
    const haystack = `${ev.title} ${(ev.attendees ?? []).join(' ')}`.toLowerCase();
    if (tokens.some((t) => haystack.includes(t))) {
      const scale = hoursAway <= 12 ? 1.0 : hoursAway <= 24 ? 0.7 : 0.4;
      return { scale, startMs: ev.startMs };
    }
  }
  return null;
}

/** "Thu 14:00" — local short form of an event start in the user's effective tz. */
export function fmtEventShort(startMs: number, tz: string): string {
  const date = new Date(startMs);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${wd} ${get('hour')}:${get('minute')}`;
}

/** One line, ≤60 chars, for the why_now open-loop detail. */
function trimDetail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

/**
 * Re-rank narratives for "latest and most meaningful now". Pure + deterministic
 * (single nowMs for the batch). Items gain `why_now` (exactly one signal;
 * open-loop beats calendar) and `now_score` (debug/observability — the app
 * ignores it).
 */
export function rankNarrativesNow(
  narratives: NowRankableNarrative[],
  events: CalendarEventLite[],
  nowMs: number,
  tz: string,
): Array<NowRankableNarrative & { why_now: WhyNow; now_score: number }> {
  const ranked = narratives.map((n) => {
    // open_loop v1: the narrative carries a non-empty open thread.
    const openThreads = n.openThreads ?? [];
    const openLoop = openThreads.length > 0 && String(openThreads[0]).trim().length > 0 ? 1 : 0;

    const cal = calendarProximity(n, events, nowMs);

    const lastIso = n.lastObservedAt ?? n.firstObservedAt;
    const lastMs = lastIso ? Date.parse(lastIso) : NaN;
    const recency = Number.isFinite(lastMs)
      ? Math.exp((-Math.LN2 * Math.max(0, nowMs - lastMs)) / (RECENCY_HALF_LIFE_HOURS * 3_600_000))
      : 0;

    const statusWeight = n.status === 'active' ? 1.0 : n.status === 'dormant' ? 0.3 : 0;

    // Volume: deliberately NOT a factor.
    const score =
      0.35 * openLoop + 0.30 * (cal?.scale ?? 0) + 0.25 * recency + 0.10 * statusWeight;

    // Exactly one signal per row; open loop wins when both fire.
    const whyNow: WhyNow = openLoop
      ? { kind: 'open_loop', detail: trimDetail(String(openThreads[0])) }
      : cal
        ? { kind: 'calendar', detail: fmtEventShort(cal.startMs, tz) }
        : { kind: null, detail: null };

    return { ...n, why_now: whyNow, now_score: Math.round(score * 10_000) / 10_000 };
  });

  ranked.sort((a, b) =>
    b.now_score - a.now_score
    || (Date.parse(b.lastObservedAt ?? '') || 0) - (Date.parse(a.lastObservedAt ?? '') || 0)
    || String(a.title ?? '').localeCompare(String(b.title ?? '')));
  return ranked;
}

interface CalendarHit {
  _source?: { title?: string; attendees?: string[] | string; start_time?: string };
}

/**
 * All calendar events in the next 48h (excluding kind=instruction ticklers —
 * agent-private review notes, same filter the Today card applies). Fetched
 * ONCE per request; matching happens in memory per narrative. Missing index
 * (fresh deploy) degrades to no-calendar-signal WITH a warn — never silently.
 */
async function fetchUpcomingEvents(es: Client, userId: string, now: Date): Promise<CalendarEventLite[]> {
  try {
    const result = await es.search({
      index: CALENDAR_INDEX,
      query: {
        bool: {
          filter: [
            { term: { user_id: userId } },
            {
              range: {
                start_time: {
                  gte: now.toISOString(),
                  lt: new Date(now.getTime() + CAL_WINDOW_HOURS * 3_600_000).toISOString(),
                },
              },
            },
          ],
          must_not: [{ term: { kind: 'instruction' } }],
        },
      },
      sort: [{ start_time: 'asc' }],
      size: 200,
      _source: ['title', 'attendees', 'start_time'],
    });
    return (result.hits.hits as CalendarHit[])
      .map((h) => {
        const src = h._source;
        const startMs = src?.start_time ? Date.parse(src.start_time) : NaN;
        if (!Number.isFinite(startMs)) return null;
        const attendees = Array.isArray(src?.attendees)
          ? src.attendees
          : src?.attendees ? [src.attendees] : [];
        return { title: src?.title ?? '', attendees, startMs };
      })
      .filter((e): e is CalendarEventLite => e !== null);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/index_not_found_exception/.test(message)) {
      logger.warn('[narratives][now] calendar index missing — ranking without calendar proximity', {
        index: CALENDAR_INDEX,
      });
      return [];
    }
    throw err;
  }
}

/**
 * Call a personal-knowledge MCP tool, forwarding the CALLER's bearer token so the
 * MCP scopes to the right user (multi-tenant-safe). Connects per request (cheap;
 * mirrors the MCP health probe), returns the parsed JSON of the first text content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callKnowledge(
  baseUrl: string,
  authHeader: string,
  tool: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
  let client: McpClient | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: authHeader } },
    });
    client = new McpClient({ name: 'll5-gateway-narratives', version: '0.1.0' }, { capabilities: {} });
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${MCP_TIMEOUT_MS}ms`)), MCP_TIMEOUT_MS)),
    ]);
    const res = await Promise.race([
      client.callTool({ name: tool, arguments: args }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${MCP_TIMEOUT_MS}ms`)), MCP_TIMEOUT_MS)),
    ]);
    const content = res.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/**
 * Read-only narratives API for the web dashboard + mobile app — one auth surface
 * (Bearer ll5 token → caller's user_id) proxying the personal-knowledge MCP. List
 * is relevance-sorted; detail bundles the observation timeline + the connection
 * map; summarize fires an EPHEMERAL agent summary (does not mutate the narrative).
 */
export interface NarrativesRouterOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createNarrativesRouter(
  pool: Pool,
  es: Client,
  authSecret: string,
  knowledgeMcpUrl: string,
  options: NarrativesRouterOptions = {},
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const nowFn = options.now ?? (() => new Date());

  // GET /narratives — relevance- (default), recency-, or now-sorted list + search.
  // sort=now (the mobile Topics rail): fetch the top actives by relevance from
  // the MCP, then re-rank in the gateway (see rankNarrativesNow) — items gain
  // `why_now`.
  router.get('/narratives', authMw, async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (!auth) return void res.status(401).json({ error: 'missing authorization' });
    const userId = (req as Request & { userId: string }).userId;
    try {
      const { status, sort, q, subject_kind, limit, offset } = req.query;
      const wantNow = sort === 'now';
      const out = await callKnowledge(knowledgeMcpUrl, auth, 'list_narratives', {
        status: typeof status === 'string' ? status : 'active',
        sort: wantNow ? 'relevance' : sort === 'recency' ? 'recency' : sort === 'active' ? 'active' : 'relevance',
        query: typeof q === 'string' && q ? q : undefined,
        subject_kind: typeof subject_kind === 'string' ? subject_kind : undefined,
        limit: wantNow ? NOW_FETCH_LIMIT : limit ? Math.min(Number(limit) || 50, 200) : 50,
        // ISS-019: MCP read results are capped at ~20 KB by default (the agent's
        // context budget). The dashboard rail/list is a UI consumer — ask for the
        // full page so a 100-narrative list isn't silently cut to the first ~30.
        max_chars: 250_000,
        offset: wantNow ? 0 : offset ? Number(offset) || 0 : 0,
      });
      const narratives = (out?.narratives ?? []) as NowRankableNarrative[];
      if (!wantNow) {
        return void res.json({ narratives, total: out?.total ?? 0 });
      }
      const now = nowFn();
      const [tz, events] = await Promise.all([
        getEffectiveTimezone(pool, userId),
        fetchUpcomingEvents(es, userId, now),
      ]);
      res.json({
        narratives: rankNarrativesNow(narratives, events, now.getTime(), tz),
        total: out?.total ?? 0,
      });
    } catch (err) {
      logger.error('[narratives][list] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'Failed to load narratives.' });
    }
  });

  // GET /narratives/detail?kind=&ref= — narrative + observation timeline + connections.
  router.get('/narratives/detail', authMw, async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (!auth) return void res.status(401).json({ error: 'missing authorization' });
    const kind = String(req.query.kind ?? '');
    const ref = String(req.query.ref ?? '');
    if (!SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number]) || !ref) {
      return void res.status(400).json({ error: 'valid kind (person|place|group|topic) and ref required' });
    }
    const subject = { kind, ref };
    try {
      const [detail, connections] = await Promise.all([
        callKnowledge(knowledgeMcpUrl, auth, 'get_narrative', { subject, observation_limit: 60, max_chars: 200_000 }), // ISS-019: UI consumer, uncapped page
        callKnowledge(knowledgeMcpUrl, auth, 'get_narrative_connections', { subject }),
      ]);
      res.json({
        narrative: detail?.narrative ?? null,
        observations: detail?.observations ?? [],
        connections: connections ?? { subject, entities: [], related: [] },
      });
    } catch (err) {
      logger.error('[narratives][detail] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'Failed to load narrative.' });
    }
  });

  // POST /narratives/summarize { kind, ref } — fire an EPHEMERAL point-in-time
  // agent summary. The agent replies it into the chat thread; it does NOT
  // upsert/overwrite the stored narrative. Returns event_id for UI correlation.
  router.post('/narratives/summarize', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { kind, ref } = (req.body ?? {}) as { kind?: string; ref?: string };
    if (!kind || !SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number]) || !ref) {
      return void res.status(400).json({ error: 'valid kind (person|place|group|topic) and ref required' });
    }
    try {
      const evt = createSchedulerEvent('narrative_summary_on_demand');
      const prompt = [
        `[Narrative Summary Request] The user opened the narrative ${kind}:${ref} and asked for a fresh point-in-time summary RIGHT NOW.`,
        `Load it — recall({ subjects:[{ kind:"${kind}", ref:"${ref}" }] }) and/or get_narrative({ subject:{ kind:"${kind}", ref:"${ref}" } }) — then push_to_user a concise 3–6 sentence summary of where this thread stands at THIS moment: what it is, current state, open threads, what to watch.`,
        `This is an EPHEMERAL snapshot for the UI — DO NOT call upsert_narrative or otherwise change the stored narrative.`,
      ].join(' ');
      const messageId = await insertSystemMessage(pool, userId, prompt, undefined, evt);
      res.json({ event_id: evt.event_id, message_id: messageId });
    } catch (err) {
      logger.error('[narratives][summarize] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to request summary.' });
    }
  });

  return router;
}
