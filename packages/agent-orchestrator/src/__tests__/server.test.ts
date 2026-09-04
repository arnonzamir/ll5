import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server.js';
import { Orchestrator, type OrchestratorConfig } from '../orchestrator.js';
import { MockRuntime } from '../runtime/mock-runtime.js';
import { SecretsWriter } from '../secrets.js';
import { encrypt, decrypt } from '../encryption.js';
import { makeMockPool } from './_helpers.js';

const KEY = randomBytes(32).toString('hex');
const SECRET = 'orchestrator-shared-secret';
const API_KEY = 'sk-ant-http-test';

function config(): OrchestratorConfig {
  return {
    encryptionKey: KEY,
    image: 'ghcr.io/arnonzamir/ll5-agent:latest',
    maxContainersPerHost: 25,
    memoryBytes: 1024,
    restartPolicy: 'unless-stopped',
    gatewayUrl: 'https://ll5.noninoni.click',
    mcpBaseDomain: 'noninoni.click',
    heartbeatTimeoutSec: 180,
    restartCooldownSec: 300,
  };
}

describe('orchestrator HTTP server', () => {
  let server: Server;
  let baseUrl: string;
  let secretsDir: string;
  // mutable backing store so each test can seed rows
  let store: Map<string, Record<string, unknown>>;
  let hasCred: boolean;

  beforeAll(async () => {
    secretsDir = await mkdtemp(path.join(tmpdir(), 'll5-http-'));
  });
  afterAll(async () => {
    await rm(secretsDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  beforeEach(async () => {
    store = new Map();
    hasCred = true;
    const { pool } = makeMockPool((text, values) => {
      if (/FROM agent_llm_credentials/.test(text)) {
        return hasCred ? [{ ciphertext: encrypt(API_KEY, KEY) }] : [];
      }
      if (/count\(\*\)/.test(text)) return [{ n: '0' }];
      if (/FROM agent_runtimes WHERE status = 'running'/.test(text)) {
        return [...store.values()].filter((r) => r.status === 'running');
      }
      if (/FROM agent_runtimes WHERE user_id = \$1/.test(text)) {
        const r = store.get(values[0] as string);
        return r ? [r] : [];
      }
      if (/INSERT INTO agent_runtimes/.test(text)) {
        const [userId, status, containerId, host, lastError] = values as unknown[];
        store.set(userId as string, {
          user_id: userId,
          status,
          container_id: containerId ?? null,
          host: host ?? null,
          last_seen_at: null,
          last_error: lastError ?? null,
        });
        return [];
      }
      return undefined;
    });

    const orchestrator = new Orchestrator({
      runtime: new MockRuntime('agent-host-http'),
      pool,
      encryptor: { encrypt, decrypt },
      secrets: new SecretsWriter({ dir: secretsDir }),
      config: config(),
      agentTokenResolver: async () => 'll5.tok',
    });

    const app = createApp({ orchestrator, orchestratorSecret: SECRET });
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  const authed = (extra: RequestInit = {}): RequestInit => ({
    ...extra,
    headers: { Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json', ...(extra.headers ?? {}) },
  });

  it('GET /health is open and returns ok', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('rejects /runtimes routes without the bearer (401)', async () => {
    const res = await fetch(`${baseUrl}/runtimes/user-1/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_token: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects a wrong bearer (401)', async () => {
    const res = await fetch(`${baseUrl}/runtimes/user-1`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('POST provision returns status/container_id/host', async () => {
    const res = await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({ agent_token: 'll5.tok' }) }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('running');
    expect(body.container_id).toBeTruthy();
    expect(body.host).toBe('agent-host-http');
  });

  it('POST provision without agent_token is 400', async () => {
    const res = await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({}) }),
    );
    expect(res.status).toBe(400);
  });

  it('POST provision with no LLM credential is 400 no_llm_credential', async () => {
    hasCred = false;
    const res = await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({ agent_token: 'll5.tok' }) }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('no_llm_credential');
  });

  it('POST /runtimes/reprovision-running requires the bearer (401)', async () => {
    const res = await fetch(`${baseUrl}/runtimes/reprovision-running`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('POST /runtimes/reprovision-running rolls every running agent and reports per-user outcome (DECISION-027)', async () => {
    // Nothing running yet → empty roll.
    const empty = await fetch(`${baseUrl}/runtimes/reprovision-running`, authed({ method: 'POST' }));
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ reprovisioned: [], failed: [] });

    await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({ agent_token: 'll5.tok' }) }),
    );
    const res = await fetch(`${baseUrl}/runtimes/reprovision-running`, authed({ method: 'POST' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reprovisioned: string[]; failed: string[] };
    expect(body.reprovisioned).toEqual(['user-1']);
    expect(body.failed).toEqual([]);
    expect(store.get('user-1')?.status).toBe('running');
  });

  it('POST stop returns stopped', async () => {
    await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({ agent_token: 'll5.tok' }) }),
    );
    const res = await fetch(`${baseUrl}/runtimes/user-1/stop`, authed({ method: 'POST' }));
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('stopped');
  });

  it('GET runtime returns the row, 404 when absent', async () => {
    await fetch(
      `${baseUrl}/runtimes/user-1/provision`,
      authed({ method: 'POST', body: JSON.stringify({ agent_token: 'll5.tok' }) }),
    );
    const res = await fetch(`${baseUrl}/runtimes/user-1`, authed());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.user_id).toBe('user-1');
    expect(body.status).toBe('running');

    const absent = await fetch(`${baseUrl}/runtimes/ghost`, authed());
    expect(absent.status).toBe(404);
  });
});
