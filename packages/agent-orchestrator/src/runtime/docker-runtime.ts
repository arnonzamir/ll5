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

  private request(method: string, path: string, body?: unknown): Promise<DockerResponse> {
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

  async provision(spec: RuntimeSpec): Promise<ProvisionResult> {
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
