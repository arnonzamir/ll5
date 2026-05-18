import path from 'node:path';
import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { chatAuthMiddleware } from './chat.js';
import { logger } from './utils/logger.js';

interface AuthenticatedRequest extends Request {
  userId: string;
}

/**
 * Decide whether `userId` is permitted to read `filename`.
 *
 * Files are owned by their creator, encoded in the filename:
 *   - Chat uploads (multer): `<userId>_<timestamp>_<random>.<ext>`
 *     — the full user UUID is the prefix.
 *   - WhatsApp media: `wa_<kind>_<userIdSlice8>_<timestamp>_<random>.<ext>`
 *     — only the first 8 chars of the user UUID appear (a property worth
 *       fixing separately, but tolerated here for backwards compatibility
 *       with existing files).
 *
 * The check requires a literal underscore separator after the prefix to
 * avoid the "<longerUuid>" prefix-collision attack, and rejects any
 * filename containing path separators or whitespace.
 */
export function isFileOwnedBy(userId: string, filename: string): boolean {
  if (!filename || typeof filename !== 'string') return false;
  // No path separators, null bytes, or whitespace in filenames we generate.
  if (/[\s/\\\0]/.test(filename)) return false;

  // Chat upload pattern: starts with `<userId>_`
  if (filename.startsWith(`${userId}_`)) return true;

  // WhatsApp pattern: `wa_<kind>_<userIdSlice8>_<...>`
  const waMatch = /^wa_[^_]+_([0-9a-f]{8})_/.exec(filename);
  if (waMatch && waMatch[1] === userId.slice(0, 8)) return true;

  return false;
}

export interface UploadsRouterDeps {
  authSecret: string;
  uploadsDir: string;
}

/**
 * Build a router that serves files from `uploadsDir` only to authenticated users
 * who own the requested file. Mount under `/uploads`.
 */
export function createUploadsRouter(deps: UploadsRouterDeps): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(deps.authSecret);

  router.use(authMw);

  router.use((req: Request, res: Response, next: NextFunction) => {
    const userId = (req as AuthenticatedRequest).userId;
    // Express has already URL-decoded req.path; strip leading slash to get the filename.
    const filename = req.path.replace(/^\/+/, '');
    if (!isFileOwnedBy(userId, filename)) {
      logger.warn('[uploads] Access denied', { userId, filename });
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  });

  // dotfiles: deny (don't serve hidden files even if they slipped past ownership check)
  // fallthrough: false ensures 404 instead of next() so we never leak past
  router.use(
    express.static(deps.uploadsDir, {
      dotfiles: 'deny',
      fallthrough: false,
      index: false,
    }),
  );

  // express.static with fallthrough=false sends its own 404; this handles
  // any other errors (e.g. ENOENT mapped to NextError).
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const code = (err as { status?: number } | undefined)?.status ?? 500;
    res.status(code).end();
  });

  return router;
}

/** Path resolution for the uploads directory, matching chat.ts:13 */
export function resolveUploadsDir(): string {
  return process.env.NODE_ENV === 'production' ? '/app/uploads' : './uploads';
}
