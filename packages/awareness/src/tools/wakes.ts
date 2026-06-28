import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from '@elastic/elasticsearch';
import { logAudit } from '@ll5/shared';
import { logger } from '../utils/logger.js';

const INDEX = 'll5_scheduled_wakes';

/**
 * Derive the wall-clock 'HH:MM' and day-of-week for a recurring wake from its
 * first-occurrence ISO timestamp. Uses the IANA tz when given (DST-correct),
 * else falls back to the literal local part of the ISO string (its offset).
 */
function deriveLocal(fireAt: string, tz?: string): { fireLocal: string | null; dow: number | null } {
  try {
    if (tz) {
      const d = new Date(fireAt);
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
      }).formatToParts(d);
      const hh = parts.find((p) => p.type === 'hour')?.value ?? '00';
      const mm = parts.find((p) => p.type === 'minute')?.value ?? '00';
      const wd = parts.find((p) => p.type === 'weekday')?.value ?? '';
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return { fireLocal: `${hh}:${mm}`, dow: map[wd] ?? null };
    }
    const m = /T(\d{2}):(\d{2})/.exec(fireAt);
    const fireLocal = m ? `${m[1]}:${m[2]}` : null;
    const dow = Number.isNaN(new Date(fireAt).getTime()) ? null : new Date(fireAt).getUTCDay();
    return { fireLocal, dow };
  } catch {
    return { fireLocal: null, dow: null };
  }
}

export function registerWakeTools(
  server: McpServer,
  esClient: Client,
  getUserId: () => string,
): void {
  // ---------------------------------------------------------------------------
  // create_wake — the durable, precise-time self-wake (replaces CronCreate).
  // ---------------------------------------------------------------------------
  server.tool(
    'create_wake',
    'Schedule a DURABLE, PRECISE-TIME self-wake — your replacement for CronCreate (which is blocked: session-scoped, lost on restart/compaction). At the chosen minute the gateway fires your payload as an [Agent Instruction] (agent-private, no user popup) or a user-facing reminder, surviving any restart/compaction. Use this for operational precise wakes: "re-check the dose at 09:10", staged escalations, "poll the deploy in 8 min". For a real-world reminder the USER should see on their calendar, use create_tickler instead. The payload MUST be complete and self-contained — WHAT to do, WHY, and every bit of context a future session needs to act WITHOUT re-deriving.',
    {
      fire_at: z.string().describe('First/only fire time as a full ISO 8601 timestamp WITH offset, e.g. "2026-06-28T09:10:00+03:00". For recurring wakes this also defines the wall-clock time-of-day that repeats.'),
      payload: z.string().describe('The complete, self-contained instruction the future session receives.'),
      kind: z.enum(['instruction', 'reminder']).optional().describe('"instruction" (default) = agent-private [Agent Instruction], no user popup. "reminder" = a user-facing nudge.'),
      recurrence: z.enum(['none', 'daily', 'weekly', 'weekdays']).optional().describe('Repeat pattern. Omit/"none" for a one-off. Recurring wakes fire by local wall-clock (DST-safe).'),
      tz: z.string().optional().describe('IANA timezone for a recurring wake\'s wall-clock (e.g. "Asia/Jerusalem"). Pass it when the user is travelling; omitted = the gateway uses your effective timezone at fire time.'),
      source: z.string().optional().describe('Optional tag for where this wake came from (e.g. "ritalin-escalation").'),
    },
    async ({ fire_at, payload, kind, recurrence, tz, source }) => {
      const userId = getUserId();
      const now = new Date().toISOString();
      const rec = recurrence ?? 'none';
      const wakeKind = kind ?? 'instruction';

      if (Number.isNaN(new Date(fire_at).getTime())) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: `invalid fire_at: ${fire_at}` }) }] };
      }

      let fireLocal: string | null = null;
      let dow: number | null = null;
      if (rec !== 'none') {
        const d = deriveLocal(fire_at, tz);
        fireLocal = d.fireLocal;
        dow = rec === 'weekly' ? d.dow : null;
      }

      const doc = {
        user_id: userId,
        kind: wakeKind,
        payload,
        recurrence: rec,
        fire_at: rec === 'none' ? new Date(fire_at).toISOString() : null,
        fire_local: fireLocal,
        tz: tz ?? null,
        weekly_dow: dow,
        status: 'pending',
        last_fired_date: null,
        source: source ?? null,
        created_at: now,
        fired_at: null,
        last_fired_at: null,
      };

      const result = await esClient.index({ index: INDEX, document: doc, refresh: 'wait_for' });
      logAudit({
        user_id: userId, source: 'awareness', action: 'create', entity_type: 'wake', entity_id: result._id,
        summary: `Scheduled ${rec === 'none' ? 'one-off' : rec} wake (${wakeKind})`, metadata: { recurrence: rec, source },
      });
      logger.info('[create_wake] scheduled', { id: result._id, rec, kind: wakeKind, fire_at: doc.fire_at, fire_local: fireLocal });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          id: result._id, kind: wakeKind, recurrence: rec,
          fires: rec === 'none' ? doc.fire_at : `${fireLocal} ${rec}${tz ? ` (${tz})` : ' (effective tz)'}`,
        }) }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // list_wakes
  // ---------------------------------------------------------------------------
  server.tool(
    'list_wakes',
    'List your scheduled self-wakes. Defaults to pending (not yet fired/cancelled).',
    {
      status: z.enum(['pending', 'fired', 'cancelled']).optional().describe('Filter by status (default: pending).'),
      limit: z.number().optional().describe('Max to return (default: 50).'),
    },
    async ({ status, limit }) => {
      const userId = getUserId();
      const result = await esClient.search({
        index: INDEX,
        size: limit ?? 50,
        sort: [{ created_at: { order: 'desc' } }],
        query: { bool: { must: [{ term: { user_id: userId } }, { term: { status: status ?? 'pending' } }] } },
      });
      const wakes = result.hits.hits.map((hit) => ({ id: hit._id, ...(hit._source as Record<string, unknown>) }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ wakes, total: wakes.length }) }] };
    },
  );

  // ---------------------------------------------------------------------------
  // cancel_wake
  // ---------------------------------------------------------------------------
  server.tool(
    'cancel_wake',
    'Cancel a scheduled self-wake by id (stops a one-off, or ends a recurring series).',
    { id: z.string().describe('The wake id from create_wake / list_wakes.') },
    async ({ id }) => {
      const userId = getUserId();
      try {
        const existing = await esClient.get({ index: INDEX, id }).catch(() => null);
        if (!existing || (existing._source as Record<string, unknown>)?.user_id !== userId) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'not found' }) }] };
        }
        await esClient.update({ index: INDEX, id, doc: { status: 'cancelled' }, refresh: 'wait_for' });
        logAudit({ user_id: userId, source: 'awareness', action: 'cancel', entity_type: 'wake', entity_id: id, summary: 'Cancelled wake' });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }] };
      } catch (err) {
        logger.warn('[cancel_wake] failed', { id, error: err instanceof Error ? err.message : String(err) });
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(err) }) }] };
      }
    },
  );
}
