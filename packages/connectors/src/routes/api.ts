/**
 * REST routes on the same Express app as /mcp, behind the same user-bearer
 * middleware. Deliberately NOT tools: credentials never enter the agent's tool
 * list, the gateway posts events and triggers scheduled pulls here.
 *
 *   POST /api/events                      ConnectorEventInput → ConnectorEventAck (idempotent on dedupe_key)
 *   PUT  /api/connectors/:id              { enabled?, schedule_minutes?, config? } → row (created on first call)
 *   POST /api/connectors/:id/credentials  { auth_type, secret } → 204 (encrypted; never logged)
 *   POST /api/sync                        { connector_id, scheduled? } → SyncResult (same as the tool; scheduled:true adds the due gate → { ok:false, reason:'not_due' })
 */
import type { Express, Request, Response, NextFunction, RequestHandler } from 'express';
import { catalogEntry, runWithRequestContext } from '@ll5/shared';
import type { AuthenticatedRequest, ConnectorEventInput } from '@ll5/shared';
import type { Repositories } from '../repositories/postgres/index.js';
import type { SyncService } from '../sync.js';
import { merchantKey } from '../utils/keys.js';
import { logger } from '../utils/logger.js';
import { ConnectorEventInputSchema, ConnectorPatchSchema, CredentialsBodySchema, SyncBodySchema } from '../tools/schemas.js';

export interface ApiDeps {
  repos: Repositories;
  sync: SyncService;
  merchantSubKeyHex: string;
}

type Handler = (req: Request, res: Response) => Promise<void>;

/** Wrap a handler in the request context (user id from the auth middleware) and a JSON error reply. */
function scoped(handler: Handler): RequestHandler {
  return (req: Request, res: Response, _next: NextFunction) => {
    const userId = (req as AuthenticatedRequest).userId;
    void runWithRequestContext(
      {
        userId,
        sessionId: (req.headers['x-ll5-session-id'] as string) || undefined,
        traceId: (req.headers['x-ll5-trace-id'] as string) || undefined,
      },
      async () => {
        try {
          await handler(req, res);
        } catch (err) {
          logger.error('[api] request failed', { path: req.path, error: err instanceof Error ? err.message : String(err) });
          if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
        }
      },
    );
  };
}

export function registerApiRoutes(app: Express, authMw: RequestHandler, deps: ApiDeps): void {
  const { repos, sync } = deps;

  app.post('/api/events', authMw, scoped(async (req, res) => {
    const parsed = ConnectorEventInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid event', issues: parsed.error.issues.slice(0, 10) });
      return;
    }
    const input = parsed.data as ConnectorEventInput;
    if (!catalogEntry(input.connector_id)) {
      res.status(400).json({ error: `Unknown connector: ${input.connector_id}` });
      return;
    }
    const ack = await repos.events.insert(input, merchantKey(input.merchant, deps.merchantSubKeyHex));
    res.status(ack.created ? 201 : 200).json(ack);
  }));

  app.put('/api/connectors/:id', authMw, scoped(async (req, res) => {
    const id = String(req.params.id);
    if (!catalogEntry(id)) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }
    const parsed = ConnectorPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid patch', issues: parsed.error.issues.slice(0, 10) });
      return;
    }
    const row = await repos.connectors.upsert(id, parsed.data);
    res.status(200).json(row);
  }));

  app.post('/api/connectors/:id/credentials', authMw, scoped(async (req, res) => {
    const id = String(req.params.id);
    const entry = catalogEntry(id);
    if (!entry) {
      res.status(404).json({ error: `Unknown connector: ${id}` });
      return;
    }
    const parsed = CredentialsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // Never echo the body: issues carry paths only.
      res.status(400).json({ error: 'Invalid credentials body', issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) });
      return;
    }
    await repos.connectors.upsert(id, {});
    await repos.credentials.put(id, parsed.data.auth_type, parsed.data.secret);
    logger.info('[api] credentials stored', { connectorId: id, authType: parsed.data.auth_type });
    res.status(204).end();
  }));

  app.post('/api/sync', authMw, scoped(async (req, res) => {
    const parsed = SyncBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid body', issues: parsed.error.issues.slice(0, 10) });
      return;
    }
    const id = parsed.data.connector_id;
    if (!catalogEntry(id)) {
      res.status(404).json({ ok: false, connector_id: id, reason: 'unknown_connector' });
      return;
    }
    res.status(200).json(await sync.run(id, { scheduled: parsed.data.scheduled === true }));
  }));
}
