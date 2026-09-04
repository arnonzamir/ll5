import crypto from 'node:crypto';
import express from 'express';
import type { Request, Response, NextFunction, Express } from 'express';
import { logger } from './logger.js';
import {
  Orchestrator,
  CapacityError,
  MissingCredentialError,
} from './orchestrator.js';

/** Constant-time compare for the shared bearer secret. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export interface ServerDeps {
  orchestrator: Orchestrator;
  /** Shared bearer secret the gateway presents server-to-server. */
  orchestratorSecret: string;
}

/**
 * Build the Express app. Every /runtimes route requires
 * `Authorization: Bearer <ORCHESTRATOR_SECRET>` (constant-time compare).
 * /health is open.
 */
export function createApp(deps: ServerDeps): Express {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  const auth = (req: Request, res: Response, next: NextFunction): void => {
    const header = req.headers.authorization;
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : '';
    if (!presented || !safeEqual(presented, deps.orchestratorSecret)) {
      logger.warn('[orchestrator-http] rejected: bad bearer', { path: req.path });
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };

  app.post(
    '/runtimes/:userId/provision',
    auth,
    async (req: Request, res: Response): Promise<void> => {
      const userId = String(req.params.userId);
      const agentToken =
        typeof req.body?.agent_token === 'string' ? req.body.agent_token : '';
      if (!agentToken) {
        res.status(400).json({ error: 'missing_agent_token' });
        return;
      }
      try {
        const result = await deps.orchestrator.provisionForUser(userId, agentToken);
        res.json({
          status: result.status,
          container_id: result.containerId,
          host: result.host,
        });
      } catch (err) {
        if (err instanceof MissingCredentialError) {
          res.status(400).json({ error: 'no_llm_credential' });
          return;
        }
        if (err instanceof CapacityError) {
          res.status(429).json({ error: 'capacity' });
          return;
        }
        logger.error('[orchestrator-http] provision failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: 'provision_failed' });
      }
    },
  );

  // Deploy-time image roll (DECISION-027): re-provision every running agent onto
  // the current image. Called by the ll5 deploy job right after it rebuilt
  // run-claude (and by an operator via the same bearer). Per-user failures are
  // reported in the body, not as an HTTP failure.
  app.post('/runtimes/reprovision-running', auth, async (_req: Request, res: Response) => {
    try {
      const result = await deps.orchestrator.reprovisionRunning();
      res.json(result);
    } catch (err) {
      logger.error('[orchestrator-http] reprovision-running failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(500).json({ error: 'reprovision_failed' });
    }
  });

  app.post(
    '/runtimes/:userId/stop',
    auth,
    async (req: Request, res: Response): Promise<void> => {
      const userId = String(req.params.userId);
      try {
        const result = await deps.orchestrator.stopForUser(userId);
        res.json(result);
      } catch (err) {
        logger.error('[orchestrator-http] stop failed', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
        res.status(500).json({ error: 'stop_failed' });
      }
    },
  );

  app.get(
    '/runtimes/:userId',
    auth,
    async (req: Request, res: Response): Promise<void> => {
      const row = await deps.orchestrator.statusForUser(String(req.params.userId));
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({
        user_id: row.user_id,
        status: row.status,
        container_id: row.container_id,
        host: row.host,
        last_seen_at: row.last_seen_at,
        last_error: row.last_error,
      });
    },
  );

  return app;
}
