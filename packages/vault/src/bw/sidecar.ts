/**
 * bw CLI sidecar manager (DECISION-022 §2).
 *
 * Boot sequence: `bw config server` → `bw login --apikey` (BW_CLIENTID /
 * BW_CLIENTSECRET from env) → spawn `bw serve --hostname 127.0.0.1` →
 * POST /unlock with the master password (localhost-only request body; never
 * an argv, so it can't appear in `ps`). The secret's whole lifecycle stays
 * inside this container.
 *
 * The serve process is supervised: if it exits it is relaunched with
 * backoff and re-unlocked. Health = GET /status on the serve port.
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { logger } from '../utils/logger.js';
import { sanitizeError } from '../utils/redact.js';

export interface BwSidecarConfig {
  vaultUrl: string;
  clientId: string;
  clientSecret: string;
  password: string;
  servePort: number;
  /** bw executable name/path (default 'bw'). */
  bwBin?: string;
}

export type BwStatus = 'unauthenticated' | 'locked' | 'unlocked' | 'down';

const RESTART_BACKOFF_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

export class BwSidecar {
  private child: ChildProcess | null = null;
  private shuttingDown = false;
  private restartCount = 0;
  private readonly bwBin: string;

  constructor(private readonly config: BwSidecarConfig) {
    this.bwBin = config.bwBin ?? 'bw';
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.config.servePort}`;
  }

  /** Run a one-shot bw CLI command. Secrets go via env, never argv. */
  private exec(args: string[], extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        this.bwBin,
        args,
        {
          env: { ...process.env, BW_NOINTERACTION: 'true', ...extraEnv },
          timeout: 60_000,
        },
        (err, stdout, stderr) => {
          const rawCode: unknown = err ? (err as NodeJS.ErrnoException & { code?: unknown }).code ?? 1 : 0;
          resolve({ code: typeof rawCode === 'number' ? rawCode : 1, stdout: String(stdout), stderr: String(stderr) });
        },
      );
    });
  }

  async start(): Promise<void> {
    // 1. Point the CLI at our Vaultwarden.
    const cfg = await this.exec(['config', 'server', this.config.vaultUrl]);
    if (cfg.code !== 0 && !/already/i.test(cfg.stderr)) {
      // `bw config server` fails if logged in against another server — surface loudly.
      logger.warn('[BwSidecar][start] bw config server non-zero', { code: cfg.code });
    }

    // 2. Login with the machine account API key (idempotent).
    const check = await this.exec(['login', '--check']);
    if (check.code !== 0) {
      const login = await this.exec(['login', '--apikey'], {
        BW_CLIENTID: this.config.clientId,
        BW_CLIENTSECRET: this.config.clientSecret,
      });
      if (login.code !== 0) {
        throw new Error(`bw login --apikey failed: ${sanitizeError(login.stderr, [this.config.clientSecret, this.config.password])}`);
      }
      logger.info('[BwSidecar][start] bw login ok');
    } else {
      logger.info('[BwSidecar][start] bw already logged in');
    }

    // 3. Spawn bw serve and unlock it over localhost.
    await this.spawnServe();
  }

  private async spawnServe(): Promise<void> {
    if (this.shuttingDown) return;

    const child = spawn(
      this.bwBin,
      ['serve', '--hostname', '127.0.0.1', '--port', String(this.config.servePort)],
      { env: { ...process.env, BW_NOINTERACTION: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    this.child = child;

    child.stdout?.on('data', () => { /* bw serve is chatty; status is polled instead */ });
    child.stderr?.on('data', (buf: Buffer) => {
      logger.warn('[BwSidecar][serve] stderr', {
        line: sanitizeError(buf.toString(), [this.config.password, this.config.clientSecret]),
      });
    });

    child.on('exit', (code) => {
      this.child = null;
      if (this.shuttingDown) return;
      const delay = RESTART_BACKOFF_MS[Math.min(this.restartCount, RESTART_BACKOFF_MS.length - 1)];
      this.restartCount += 1;
      logger.error('[BwSidecar][serve] bw serve exited — restarting', { code, restart_in_ms: delay, restart_count: this.restartCount });
      setTimeout(() => {
        void this.spawnServe().catch((err) => {
          logger.error('[BwSidecar][serve] restart failed', { error: sanitizeError(err, [this.config.password, this.config.clientSecret]) });
        });
      }, delay);
    });

    // Wait for the HTTP surface, then unlock.
    const up = await this.waitForServe(30_000);
    if (!up) {
      logger.error('[BwSidecar][serve] bw serve did not come up within 30s');
      return;
    }
    await this.unlock();
    this.restartCount = 0;
  }

  private async waitForServe(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${this.baseUrl}/status`);
        if (res.ok) return true;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  private async unlock(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/unlock`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: this.config.password }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        logger.error('[BwSidecar][unlock] unlock failed', {
          status: res.status,
          error: sanitizeError(body, [this.config.password, this.config.clientSecret]),
        });
        return;
      }
      logger.info('[BwSidecar][unlock] vault unlocked');
    } catch (err) {
      logger.error('[BwSidecar][unlock] unlock request failed', {
        error: sanitizeError(err, [this.config.password, this.config.clientSecret]),
      });
    }
  }

  /** Health probe: bw serve /status. */
  async status(): Promise<BwStatus> {
    try {
      const res = await fetch(`${this.baseUrl}/status`);
      if (!res.ok) return 'down';
      const body = (await res.json()) as { data?: { template?: { status?: string } } };
      const s = body?.data?.template?.status;
      if (s === 'unlocked' || s === 'locked' || s === 'unauthenticated') return s;
      return 'down';
    } catch {
      return 'down';
    }
  }

  /** Pull fresh vault data (new/changed items land without a restart). */
  async sync(): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/sync`, { method: 'POST' });
    } catch (err) {
      logger.warn('[BwSidecar][sync] sync failed', { error: sanitizeError(err, [this.config.password]) });
    }
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}
