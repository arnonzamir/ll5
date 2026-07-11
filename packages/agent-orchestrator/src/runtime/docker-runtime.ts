import http from 'node:http';
import { logger } from '../logger.js';
import type { Runtime, RuntimeSpec, ProvisionResult, RuntimeStatus } from './runtime.js';

/**
 * Real Runtime over the Docker Engine API via the local Unix socket
 * (`/var/run/docker.sock`), using only Node's built-in `http` — no dockerode.
 *
 * This is built but NOT exercised in tests (it needs a real Docker socket).
 * Tests use MockRuntime. The orchestrator-level guarantees (no secret in argv,
 * env-file mounted read-only) are verified at the MockRuntime/Orchestrator seam.
 */
export interface DockerRuntimeOptions {
  socketPath?: string;
  /** Logical name of this agent host, recorded in agent_runtimes.host. */
  host?: string;
}

interface DockerResponse {
  status: number;
  body: string;
}

export class DockerRuntime implements Runtime {
  private readonly socketPath: string;
  readonly host: string;

  constructor(opts: DockerRuntimeOptions = {}) {
    this.socketPath = opts.socketPath ?? '/var/run/docker.sock';
    this.host = opts.host ?? process.env.AGENT_HOST_NAME ?? 'agent-host-1';
  }

  private request(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<DockerResponse> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path,
          headers: {
            'Content-Type': 'application/json',
            ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
            ...(extraHeaders ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
          );
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  private labelFilter(userId: string): string {
    return encodeURIComponent(JSON.stringify({ label: [`ll5.user_id=${userId}`] }));
  }

  /**
   * Best-effort pull of the image before create, so a provision never silently
   * runs a STALE local image. (`docker pull` on the host can report "up to date"
   * without refreshing the :latest digest, and the orchestrator create uses
   * whatever tag is local — that quietly re-ran old builds during 2026-07-11.)
   * A private GHCR image needs auth: set GHCR_PULL_TOKEN (+ GHCR_PULL_USER).
   * Any failure (auth, network) is logged and IGNORED — create then falls back
   * to the local image rather than blocking provisioning.
   */
  private async pullImage(image: string): Promise<void> {
    const slash = image.lastIndexOf('/');
    const colon = image.lastIndexOf(':');
    const hasTag = colon > slash;
    const fromImage = hasTag ? image.slice(0, colon) : image;
    const tag = hasTag ? image.slice(colon + 1) : 'latest';
    const headers: Record<string, string> = {};
    const token = process.env.GHCR_PULL_TOKEN;
    if (token) {
      headers['X-Registry-Auth'] = Buffer.from(
        JSON.stringify({ username: process.env.GHCR_PULL_USER || 'x-access-token', password: token }),
      ).toString('base64');
    }
    try {
      const res = await this.request(
        'POST',
        `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`,
        undefined,
        headers,
      );
      if (res.status >= 300) {
        logger.warn('[docker] image pull non-2xx — using local image', { image, status: res.status });
      } else {
        logger.info('[docker] pulled latest image before provision', { image });
      }
    } catch (err) {
      logger.warn('[docker] image pull failed — using local image', {
        image,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async provision(spec: RuntimeSpec): Promise<ProvisionResult> {
    // Refresh the image first so we never run a stale local build (best-effort).
    await this.pullImage(spec.image);

    // SECURITY: secrets are NOT in Env/Cmd here. They live in the 0600 env-file
    // bind-mounted read-only at spec.envFileTarget; the base-image entrypoint
    // sources it. We pass only the env-file *path* (non-secret) via Env so the
    // entrypoint knows where to look.
    const createBody = {
      Image: spec.image,
      Labels: spec.labels,
      Env: [`LL5_AGENT_ENV_FILE=${spec.envFileTarget}`],
      HostConfig: {
        Binds: [`${spec.envFilePath}:${spec.envFileTarget}:ro`],
        RestartPolicy: { Name: spec.restartPolicy },
        Memory: spec.memoryBytes,
        // Pin a swap == memory so the limit is hard (no swap escape hatch).
        MemorySwap: spec.memoryBytes,
        // Join the ll5 stack network so the container resolves gateway/mcp-* by
        // hostname. Without this it lands on the default bridge and is isolated.
        ...(spec.network ? { NetworkMode: spec.network } : {}),
      },
    };

    const created = await this.request(
      'POST',
      `/containers/create?name=${encodeURIComponent(`ll5-agent-${spec.userId}`)}`,
      createBody,
    );
    if (created.status >= 300) {
      throw new Error(`Docker create failed (${created.status}): ${created.body}`);
    }
    const containerId = (JSON.parse(created.body) as { Id: string }).Id;

    const started = await this.request('POST', `/containers/${containerId}/start`);
    if (started.status >= 300 && started.status !== 304) {
      throw new Error(`Docker start failed (${started.status}): ${started.body}`);
    }

    logger.info('[docker] provisioned container', {
      userId: spec.userId,
      containerId,
      host: this.host,
    });
    return { containerId, host: this.host };
  }

  async stop(userId: string): Promise<void> {
    const list = await this.request('GET', `/containers/json?all=1&filters=${this.labelFilter(userId)}`);
    if (list.status >= 300) {
      throw new Error(`Docker list failed (${list.status}): ${list.body}`);
    }
    const containers = JSON.parse(list.body) as Array<{ Id: string }>;
    for (const c of containers) {
      // Best-effort stop (10s grace) then force-remove.
      await this.request('POST', `/containers/${c.Id}/stop?t=10`);
      const removed = await this.request('DELETE', `/containers/${c.Id}?force=1`);
      if (removed.status >= 300 && removed.status !== 404) {
        throw new Error(`Docker remove failed (${removed.status}): ${removed.body}`);
      }
    }
    logger.info('[docker] stopped containers', { userId, count: containers.length });
  }

  async status(userId: string): Promise<RuntimeStatus> {
    const list = await this.request('GET', `/containers/json?all=1&filters=${this.labelFilter(userId)}`);
    if (list.status >= 300) {
      throw new Error(`Docker list failed (${list.status}): ${list.body}`);
    }
    const containers = JSON.parse(list.body) as Array<{ Id: string; State: string }>;
    const running = containers.find((c) => c.State === 'running');
    if (running) return { running: true, containerId: running.Id };
    if (containers.length > 0) return { running: false, containerId: containers[0].Id };
    return { running: false };
  }
}
