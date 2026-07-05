import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logAudit } from '@ll5/shared';
import { chatAuthMiddleware } from './chat.js';
import { insertSystemMessage, createSchedulerEvent } from './utils/system-message.js';
import { getEffectiveTimezone } from './utils/timezone.js';
import { logger } from './utils/logger.js';

/**
 * Mobile GTD surfaces (android-companion-ui Phase 4) — the phone's THREE
 * sanctioned GTD verbs: capture-triage (inbox swipes), shopping checklist,
 * and the read-mostly "Today's actions" pane. Deliberately NOT a GTD manager
 * (interaction model §3: no project browser, no action editor, no filters).
 *
 * The gateway shares the ll5 Postgres with the gtd MCP, so every write here
 * mirrors the MCP's own semantics EXACTLY:
 *
 *   inbox triage  — gtd_inbox process() semantics (status='processed' +
 *                   outcome_type/outcome_id/processed_at), keep/done also
 *                   create the horizon-0 action the way createAction() does.
 *   shopping      — items are gtd_horizons rows with list_type='shopping';
 *                   "stores" are the gtd tool's category grouping
 *                   (tools/shopping.ts); check/uncheck = updateAction's
 *                   status completed/active completed_at lifecycle.
 *   actions today — read view over active horizon-0 non-shopping actions;
 *                   complete/defer mirror updateAction, defer additionally
 *                   tells the agent via a system message.
 *
 * FROZEN CONTRACT — the Android app is built against these exact shapes.
 * All routes chatAuth + user-scoped. GET routes degrade to empty arrays on
 * 42P01 (pre-migration deploy) WITH a logger.warn — never silently.
 */

// ---------------------------------------------------------------------------
// Frozen response shapes
// ---------------------------------------------------------------------------

export interface InboxListItem {
  id: string;
  content: string;
  source: string | null;
  created_at: string;
}

export interface ShoppingItem {
  id: string;
  title: string;
  checked: boolean;
}

export interface ShoppingStore {
  /** The gtd category (the tool's store/group axis); null = ungrouped. */
  name: string | null;
  items: ShoppingItem[];
}

export interface TodayActionItem {
  id: string;
  title: string;
  /** First context tag — the row's single "context word". */
  context: string | null;
  /** YYYY-MM-DD. */
  due_date: string;
}

const INBOX_PAGE = 10;
const ACTIONS_LIMIT = 7;
const TITLE_MAX = 200;
const STORE_MAX = 100;
// Longest inbox content we echo into an agent system message (project/followup
// need enough of the capture to reason about it, without dumping a whole note).
const CONTENT_MAX = 400;
// Frozen action contract (the Android app is built against this exact set).
//   keep|trash|someday|done  — instant, processed synchronously (existing).
//   reference                — instant, processed/reference; agent files it.
//   project|followup         — DEFERRED: item goes to 'reviewed', the agent
//                              decides & finishes it (card → processed).
const TRIAGE_ACTIONS = ['keep', 'trash', 'someday', 'done', 'reference', 'project', 'followup'] as const;
type TriageAction = (typeof TRIAGE_ACTIONS)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the table is missing (pre-migration deploy) — log and degrade. */
function isMissingTable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01';
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) : flat;
}

/** The local calendar date (YYYY-MM-DD) of an instant in a zone. */
function localDateInTz(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** YYYY-MM-DD plus n days — pure calendar math via Date.UTC (tz-free). */
function plusDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export interface GtdSurfacesRouterOptions {
  /** Injectable clock for tests. */
  now?: () => Date;
}

export function createGtdSurfacesRouter(
  pool: Pool,
  authSecret: string,
  options: GtdSurfacesRouterOptions = {},
): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);
  const nowFn = options.now ?? (() => new Date());

  // -------------------------------------------------------------------------
  // Inbox — swipe-triage source (card stack, sessions of 10; the APP owns the
  // 10-cap, this endpoint just serves the next page + the honest remainder).
  // -------------------------------------------------------------------------

  // GET /me/inbox — oldest captured first (same order the gtd MCP lists),
  // limit 10, remaining = what's left beyond this page ("10 done · 36 remain").
  router.get('/me/inbox', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      let items: InboxListItem[] = [];
      let total = 0;
      try {
        const [list, count] = await Promise.all([
          pool.query<{ id: string; content: string; source: string | null; created_at: Date | string }>(
            `SELECT id, content, source, created_at
             FROM gtd_inbox
             WHERE user_id = $1 AND status = 'captured'
             ORDER BY created_at ASC
             LIMIT ${INBOX_PAGE}`,
            [userId],
          ),
          pool.query<{ count: string }>(
            `SELECT COUNT(*) AS count FROM gtd_inbox WHERE user_id = $1 AND status = 'captured'`,
            [userId],
          ),
        ]);
        items = list.rows.map((r) => ({
          id: r.id,
          content: r.content,
          source: r.source,
          created_at: new Date(r.created_at).toISOString(),
        }));
        total = parseInt(count.rows[0]?.count ?? '0', 10);
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        logger.warn('[gtd-surfaces][inbox] gtd_inbox missing (pre-migration) — empty inbox');
      }
      res.json({ items, remaining: Math.max(0, total - items.length) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][inbox] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/inbox/:id/triage { action } — one swipe.
  // action ∈ keep|trash|someday|done|reference|project|followup.
  //
  // The first four mirror the gtd MCP's process_inbox_item semantics exactly
  // (instant, processed synchronously, NO per-swipe message — the batch
  // triage-summary handles the kept ones):
  //   trash   → processed / trash
  //   someday → processed / someday
  //   keep    → processed / action + create an ACTIVE horizon-0 todo action
  //             (title = content trimmed ≤200, category null) as outcome_id —
  //             deliberately bare; the agent refines context/energy after the
  //             session (see /me/inbox/triage-summary).
  //   done    → processed / action + the same action pre-completed
  //             (do-now ≤2min — it happened, log it honestly).
  //
  // The three new verbs each SELF-ANNOUNCE with one system message (they are
  // NOT in the batch summary) and are deliberately NOT synchronous writes:
  //   reference → processed / reference (NO gtd action) + a message telling the
  //               agent to file it in personal-knowledge. INSTANT.
  //   project   → DEFERRED. status='reviewed' (off the triage stack, not yet
  //               processed), notes 'triage:project'; the agent decides
  //               existing-vs-new via add_tray_item and finishes the item.
  //   followup  → DEFERRED. status='reviewed', notes 'triage:followup'; the
  //               agent proposes a next action / waiting-for via add_tray_item.
  router.post('/me/inbox/:id/triage', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const inboxId = String(req.params.id ?? '');
    const { action } = (req.body ?? {}) as { action?: unknown };

    if (!UUID_RE.test(inboxId)) {
      return void res.status(400).json({ error: 'id must be a UUID' });
    }
    if (typeof action !== 'string' || !(TRIAGE_ACTIONS as readonly string[]).includes(action)) {
      return void res.status(400).json({ error: `action must be one of: ${TRIAGE_ACTIONS.join(', ')}` });
    }
    const triage = action as TriageAction;

    try {
      const itemRes = await pool.query<{ id: string; content: string; status: string }>(
        `SELECT id, content, status FROM gtd_inbox WHERE id = $1 AND user_id = $2`,
        [inboxId, userId],
      );
      const item = itemRes.rows[0];
      if (!item) return void res.status(404).json({ error: 'Inbox item not found' });
      if (item.status !== 'captured') {
        return void res.status(409).json({ error: 'Inbox item already processed' });
      }

      // reference — INSTANT. Mirror the gtd 'reference' outcome: processed with
      // outcome_type='reference' and NO gtd action; the agent stores it as a
      // fact/note in personal-knowledge (told via one system message).
      if (triage === 'reference') {
        const filed = await pool.query<{ id: string }>(
          `UPDATE gtd_inbox
           SET status = 'processed',
               outcome_type = 'reference',
               outcome_id = NULL,
               processed_at = now(),
               updated_at = now()
           WHERE id = $1 AND user_id = $2 AND status = 'captured'
           RETURNING id`,
          [inboxId, userId],
        );
        if (!filed.rows[0]) return void res.status(409).json({ error: 'Inbox item already processed' });

        await insertSystemMessage(
          pool,
          userId,
          `[Inbox → Reference] The user filed this as reference (not actionable, not trash): `
          + `"${oneLine(item.content, CONTENT_MAX)}". Store it where it belongs — a fact/note in `
          + `personal-knowledge — so it's findable later. Nothing else needed.`,
        );

        logAudit({
          user_id: userId,
          source: 'gateway',
          action: 'update',
          entity_type: 'inbox_item',
          entity_id: inboxId,
          summary: `Inbox triage (phone): reference — "${oneLine(item.content, 80)}"`,
          metadata: { triage, outcome_type: 'reference' },
        });

        return void res.json({ status: 'filed', action: 'reference', inbox_id: inboxId });
      }

      // project / followup — DEFERRED to an agent decision. We do NOT create
      // anything synchronously: the item leaves the triage stack (status
      // 'reviewed', notes marker) but is NOT processed, and the agent gets a
      // self-contained instruction to finish it (add_tray_item card, or a
      // push_to_user question if genuinely ambiguous). Never left dangling.
      if (triage === 'project' || triage === 'followup') {
        const marker = `triage:${triage}`;
        const reviewed = await pool.query<{ id: string }>(
          `UPDATE gtd_inbox
           SET status = 'reviewed',
               notes = COALESCE(notes || E'\\n', '') || $3,
               updated_at = now()
           WHERE id = $1 AND user_id = $2 AND status = 'captured'
           RETURNING id`,
          [inboxId, userId, marker],
        );
        if (!reviewed.rows[0]) return void res.status(409).json({ error: 'Inbox item already processed' });

        const content = oneLine(item.content, CONTENT_MAX);
        const message = triage === 'project'
          ? `[Inbox → Project] The user wants this handled as a PROJECT: "${content}" (inbox id ${inboxId}). `
            + `Decide: does it fit an EXISTING project (check list_projects) or a NEW one? Propose a title + `
            + `one-line definition. File a decision the user answers on their phone via add_tray_item — options `
            + `like {an existing project match}, {"New: <title>"}, maybe a 2nd existing — recommended = your pick. `
            + `On their choice: create/attach and mark the inbox item processed (outcome_type project, link `
            + `outcome_id). If it's genuinely ambiguous or needs real input, push_to_user a short question INSTEAD `
            + `of a card. Never leave the inbox item dangling — processed or a pending card+plan.`
          : `[Inbox → Follow-up] The user wants a follow-up on: "${content}" (inbox id ${inboxId}). Propose EITHER `
            + `a concrete next action OR parking it as waiting-for (and WHO it waits on). File it as an add_tray_item `
            + `decision for one-tap approval — options like {"Next action: <x>"}, {"Waiting for <who>"} — `
            + `recommended = your pick. On approval, create the action (waiting_for set if delegated) + mark the `
            + `inbox item processed. Ambiguous / needs input → push_to_user a short question instead.`;
        await insertSystemMessage(pool, userId, message);

        logAudit({
          user_id: userId,
          source: 'gateway',
          action: 'update',
          entity_type: 'inbox_item',
          entity_id: inboxId,
          summary: `Inbox triage (phone): ${triage} → reviewed — "${oneLine(item.content, 80)}"`,
          metadata: { triage, status: 'reviewed', marker },
        });

        return void res.json({ status: 'pending_agent', action: triage, inbox_id: inboxId });
      }

      // keep/done create the outcome action FIRST (we need its id for
      // outcome_id) — mirror of createAction(): horizon 0, list_type todo,
      // energy default medium, empty context, category null.
      let actionId: string | null = null;
      if (triage === 'keep' || triage === 'done') {
        const title = oneLine(item.content, TITLE_MAX);
        const created = await pool.query<{ id: string }>(
          `INSERT INTO gtd_horizons (
             user_id, horizon, title, status, energy, list_type, context, category, completed_at
           ) VALUES (
             $1, 0, $2, $3, 'medium', 'todo', '[]'::jsonb, NULL,
             CASE WHEN $3 = 'completed' THEN now() ELSE NULL END
           )
           RETURNING id`,
          [userId, title, triage === 'done' ? 'completed' : 'active'],
        );
        actionId = created.rows[0].id;
      }

      const outcomeType = triage === 'trash' ? 'trash' : triage === 'someday' ? 'someday' : 'action';
      const processed = await pool.query<{ id: string }>(
        `UPDATE gtd_inbox
         SET status = 'processed',
             outcome_type = $3,
             outcome_id = $4,
             processed_at = now(),
             updated_at = now()
         WHERE id = $1 AND user_id = $2 AND status = 'captured'
         RETURNING id`,
        [inboxId, userId, outcomeType, actionId],
      );
      if (!processed.rows[0]) {
        // Raced with another processor between the read and the write —
        // compensate the orphan action so a re-swipe can't double-create.
        if (actionId) {
          await pool.query(
            `DELETE FROM gtd_horizons WHERE id = $1 AND user_id = $2 AND horizon = 0`,
            [actionId, userId],
          );
        }
        return void res.status(409).json({ error: 'Inbox item already processed' });
      }

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'inbox_item',
        entity_id: inboxId,
        summary: `Inbox triage (phone): ${triage} — "${oneLine(item.content, 80)}"`,
        metadata: { triage, outcome_type: outcomeType, action_id: actionId },
      });

      res.json({ status: 'triaged', action: triage, inbox_id: inboxId, action_id: actionId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][triage] Failed', { userId, inboxId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/inbox/triage-summary { kept: [action ids], trashed, someday, done }
  //
  // Called ONCE by the app at session end (per-swipe triages insert nothing) —
  // one [Inbox Triage] system message so the agent refines the kept actions
  // (context/energy inference) without the user being asked anything.
  // `kept` = the gtd action ids returned by the keep-triage responses.
  router.post('/me/inbox/triage-summary', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { kept, trashed, someday, done } = (req.body ?? {}) as {
      kept?: unknown; trashed?: unknown; someday?: unknown; done?: unknown;
    };

    if (kept !== undefined && (!Array.isArray(kept) || kept.some((k) => typeof k !== 'string' || !UUID_RE.test(k)))) {
      return void res.status(400).json({ error: 'kept must be an array of action UUIDs' });
    }
    const keptIds = ((kept as string[] | undefined) ?? []).slice(0, 50);
    const counts: Record<string, number> = {};
    for (const [key, value] of Object.entries({ trashed, someday, done })) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
        return void res.status(400).json({ error: `${key} must be a non-negative integer` });
      }
      counts[key] = (value as number | undefined) ?? 0;
    }
    if (keptIds.length === 0 && counts.trashed === 0 && counts.someday === 0 && counts.done === 0) {
      return void res.status(400).json({ error: 'empty triage summary' });
    }

    try {
      // Resolve the kept actions' titles so the agent doesn't have to look
      // them up (and so ids the caller got wrong are visibly absent).
      let keptRows: Array<{ id: string; title: string }> = [];
      if (keptIds.length > 0) {
        const found = await pool.query<{ id: string; title: string }>(
          `SELECT id, title FROM gtd_horizons
           WHERE user_id = $1 AND horizon = 0 AND id = ANY($2::uuid[])`,
          [userId, keptIds],
        );
        keptRows = found.rows;
      }

      const lines = [
        `[Inbox Triage] The user just triaged their GTD inbox from the phone: `
        + `${keptIds.length} kept, ${counts.done} done on the spot, ${counts.trashed} trashed, ${counts.someday} to someday.`,
      ];
      if (keptRows.length > 0) {
        lines.push(
          'The kept items are now bare horizon-0 todo actions (no context, default energy). '
          + 'Refine them NOW without asking the user: infer context tags and energy from each title, '
          + 'link an obvious project if one exists, and clean up titles that are raw capture text.',
        );
        for (const r of keptRows) lines.push(`- "${oneLine(r.title, 120)}" (id ${r.id})`);
      } else if (keptIds.length > 0) {
        lines.push('(The kept action ids did not resolve to any actions — check the gtd inbox log.)');
      }

      const evt = createSchedulerEvent('inbox_triage_summary');
      const messageId = await insertSystemMessage(pool, userId, lines.join('\n'), undefined, evt);
      res.json({ status: 'ok', message_id: messageId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][triageSummary] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // Shopping — geofenced checklist (spec §6c). Mirrors tools/shopping.ts:
  // items are horizon-0 list_type='shopping' rows; the store/group axis is
  // the gtd `category` column; checked = status 'completed'.
  // -------------------------------------------------------------------------

  // GET /me/shopping — grouped by store (category), group order = encounter
  // order of the gtd list ordering (due_date asc nulls last, newest first) —
  // the same grouping walk the gtd tool's `list` action does.
  router.get('/me/shopping', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      let rows: Array<{ id: string; title: string; status: string; category: string | null }> = [];
      try {
        const result = await pool.query<{ id: string; title: string; status: string; category: string | null }>(
          `SELECT id, title, status, category
           FROM gtd_horizons
           WHERE user_id = $1 AND horizon = 0 AND list_type = 'shopping'
             AND status IN ('active', 'completed')
             AND (start_date IS NULL OR start_date <= CURRENT_DATE)
           ORDER BY due_date ASC NULLS LAST, created_at DESC
           LIMIT 200`,
          [userId],
        );
        rows = result.rows;
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        logger.warn('[gtd-surfaces][shopping] gtd_horizons missing (pre-migration) — empty list');
      }

      const groups = new Map<string | null, ShoppingItem[]>();
      for (const r of rows) {
        const key = r.category ?? null;
        const list = groups.get(key) ?? [];
        list.push({ id: r.id, title: r.title, checked: r.status === 'completed' });
        groups.set(key, list);
      }
      const stores: ShoppingStore[] = [...groups.entries()].map(([name, items]) => ({ name, items }));
      res.json({ stores });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][shopping] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/shopping { title, store? } — the one sanctioned free-text field
  // (capture, not composition). Mirror of the gtd tool's `add`: a horizon-0
  // shopping action, energy low, category = store.
  router.post('/me/shopping', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { title, store } = (req.body ?? {}) as { title?: unknown; store?: unknown };

    if (typeof title !== 'string' || title.trim().length === 0) {
      return void res.status(400).json({ error: 'title must be a non-empty string' });
    }
    if (store !== undefined && store !== null && typeof store !== 'string') {
      return void res.status(400).json({ error: 'store must be a string' });
    }
    const cleanTitle = oneLine(title, TITLE_MAX);
    const cleanStore = typeof store === 'string' && store.trim() ? oneLine(store, STORE_MAX) : null;

    try {
      const created = await pool.query<{ id: string; title: string; category: string | null }>(
        `INSERT INTO gtd_horizons (
           user_id, horizon, title, status, energy, list_type, context, category
         ) VALUES ($1, 0, $2, 'active', 'low', 'shopping', '[]'::jsonb, $3)
         RETURNING id, title, category`,
        [userId, cleanTitle, cleanStore],
      );
      const row = created.rows[0];

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'create',
        entity_type: 'shopping_item',
        entity_id: row.id,
        summary: `Added to shopping list: ${row.title}`,
        metadata: { store: row.category },
      });

      res.json({ item: { id: row.id, title: row.title, checked: false, store: row.category } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][shoppingAdd] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/shopping/:id/check { checked } — mirror of updateAction's status
  // lifecycle: checked → completed + completed_at now; unchecked → active +
  // completed_at cleared (re-open, exactly what the gtd repo does).
  router.post('/me/shopping/:id/check', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const itemId = String(req.params.id ?? '');
    const { checked } = (req.body ?? {}) as { checked?: unknown };

    if (!UUID_RE.test(itemId)) return void res.status(400).json({ error: 'id must be a UUID' });
    if (typeof checked !== 'boolean') {
      return void res.status(400).json({ error: 'checked must be a boolean' });
    }

    try {
      const updated = await pool.query<{ id: string; title: string }>(
        checked
          ? `UPDATE gtd_horizons
             SET status = 'completed', completed_at = now(), updated_at = now()
             WHERE id = $1 AND user_id = $2 AND horizon = 0 AND list_type = 'shopping'
             RETURNING id, title`
          : `UPDATE gtd_horizons
             SET status = 'active', completed_at = NULL, updated_at = now()
             WHERE id = $1 AND user_id = $2 AND horizon = 0 AND list_type = 'shopping'
             RETURNING id, title`,
        [itemId, userId],
      );
      const row = updated.rows[0];
      if (!row) return void res.status(404).json({ error: 'Shopping item not found' });

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: checked ? 'complete' : 'update',
        entity_type: 'shopping_item',
        entity_id: row.id,
        summary: checked ? `Checked off: ${row.title}` : `Unchecked: ${row.title}`,
        metadata: { checked },
      });

      res.json({ status: 'ok', checked });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][shoppingCheck] Failed', { userId, itemId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // -------------------------------------------------------------------------
  // Today's actions — a viewport onto the agent's plan, not a manager
  // (spec §6d): ≤7 due-today-or-overdue rows; check off or defer, nothing else.
  // -------------------------------------------------------------------------

  // GET /me/actions/today — active horizon-0 non-shopping actions due today
  // or earlier (effective tz), soonest due first, capped at 7.
  router.get('/me/actions/today', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    try {
      const today = localDateInTz(nowFn(), await getEffectiveTimezone(pool, userId));
      let items: TodayActionItem[] = [];
      try {
        const result = await pool.query<{
          id: string; title: string; context: unknown; due_date: string;
        }>(
          `SELECT id, title, context, due_date::text AS due_date
           FROM gtd_horizons
           WHERE user_id = $1 AND horizon = 0 AND status = 'active'
             AND (list_type IS NULL OR list_type <> 'shopping')
             AND due_date IS NOT NULL AND due_date <= $2
           ORDER BY due_date ASC, created_at ASC
           LIMIT ${ACTIONS_LIMIT}`,
          [userId, today],
        );
        items = result.rows.map((r) => ({
          id: r.id,
          title: r.title,
          context: Array.isArray(r.context) && typeof r.context[0] === 'string' ? r.context[0] : null,
          due_date: r.due_date,
        }));
      } catch (err) {
        if (!isMissingTable(err)) throw err;
        logger.warn('[gtd-surfaces][actionsToday] gtd_horizons missing (pre-migration) — empty list');
      }
      res.json({ items });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][actionsToday] Failed', { userId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/actions/:id/complete — mirror of updateAction status='completed'.
  // Idempotent: a second tap keeps the FIRST completion time (COALESCE), so a
  // retry never rewrites history.
  router.post('/me/actions/:id/complete', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const actionId = String(req.params.id ?? '');
    if (!UUID_RE.test(actionId)) return void res.status(400).json({ error: 'id must be a UUID' });

    try {
      const updated = await pool.query<{ id: string; title: string }>(
        `UPDATE gtd_horizons
         SET status = 'completed',
             completed_at = COALESCE(completed_at, now()),
             updated_at = now()
         WHERE id = $1 AND user_id = $2 AND horizon = 0
         RETURNING id, title`,
        [actionId, userId],
      );
      const row = updated.rows[0];
      if (!row) return void res.status(404).json({ error: 'Action not found' });

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'complete',
        entity_type: 'action',
        entity_id: row.id,
        summary: `Completed (phone): ${row.title}`,
      });

      res.json({ status: 'completed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][complete] Failed', { userId, actionId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /me/actions/:id/defer — due_date = tomorrow (effective tz), a note
  // marker appended to the description, and a compact system message so the
  // agent treats the swipe as its own input ("logged as agent input", §6d).
  router.post('/me/actions/:id/defer', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const actionId = String(req.params.id ?? '');
    if (!UUID_RE.test(actionId)) return void res.status(400).json({ error: 'id must be a UUID' });

    try {
      const today = localDateInTz(nowFn(), await getEffectiveTimezone(pool, userId));
      const tomorrow = plusDays(today, 1);
      const marker = `[deferred from phone ${today} -> ${tomorrow}]`;

      const updated = await pool.query<{ id: string; title: string }>(
        `UPDATE gtd_horizons
         SET due_date = $3,
             description = COALESCE(description || E'\\n', '') || $4,
             updated_at = now()
         WHERE id = $1 AND user_id = $2 AND horizon = 0 AND status = 'active'
         RETURNING id, title`,
        [actionId, userId, tomorrow, marker],
      );
      const row = updated.rows[0];
      if (!row) return void res.status(404).json({ error: 'Action not found' });

      await insertSystemMessage(
        pool,
        userId,
        `[Actions] user deferred '${row.title}' to tomorrow (from the phone)`,
      );

      logAudit({
        user_id: userId,
        source: 'gateway',
        action: 'update',
        entity_type: 'action',
        entity_id: row.id,
        summary: `Deferred to ${tomorrow} (phone): ${row.title}`,
        metadata: { due_date: tomorrow },
      });

      res.json({ status: 'deferred', due_date: tomorrow });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[gtd-surfaces][defer] Failed', { userId, actionId, error: message });
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
