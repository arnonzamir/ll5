import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  Orchestrator,
  CapacityError,
  MissingCredentialError,
  type OrchestratorConfig,
  type AgentRuntimeRow,
} from '../orchestrator.js';
import { MockRuntime } from '../runtime/mock-runtime.js';
import { SecretsWriter } from '../secrets.js';
import { encrypt, decrypt } from '../encryption.js';
import { makeMockPool } from './_helpers.js';

const KEY = randomBytes(32).toString('hex');
const API_KEY = 'sk-ant-the-users-real-key';
const AGENT_TOKEN = 'll5.agent.token.value';

function baseConfig(over: Partial<OrchestratorConfig> = {}): OrchestratorConfig {
  return {
    encryptionKey: KEY,
    image: 'ghcr.io/arnonzamir/ll5-agent:latest',
    maxContainersPerHost: 25,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    restartPolicy: 'unless-stopped',
    gatewayUrl: 'https://ll5.noninoni.click',
    mcpBaseDomain: 'noninoni.click',
    heartbeatTimeoutSec: 180,
    restartCooldownSec: 300,
    ...over,
  };
}

/**
 * A stateful fake of the agent_runtimes table backed by the mock pool. Handles
 * the SELECT ciphertext, the count, the SELECT row, and the upsert.
 */
function makeRuntimesDb(opts: {
  ciphertext?: string;
  liveCount?: number;
  rows?: Map<string, Partial<AgentRuntimeRow>>;
}) {
  const rows = opts.rows ?? new Map<string, Partial<AgentRuntimeRow>>();
  const responder = (text: string, values: unknown[]): unknown[] | undefined => {
    if (/FROM agent_llm_credentials/.test(text)) {
      return opts.ciphertext ? [{ ciphertext: opts.ciphertext }] : [];
    }
    if (/count\(\*\)/.test(text)) {
      const live =
        opts.liveCount ??
        [...rows.values()].filter(
          (r) => r.status === 'running' || r.status === 'provisioning',
        ).length;
      return [{ n: String(live) }];
    }
    if (/SELECT[\s\S]*FROM agent_runtimes WHERE status = 'running'/.test(text)) {
      return [...rows.values()].filter((r) => r.status === 'running');
    }
    if (/SELECT[\s\S]*FROM agent_runtimes WHERE user_id = \$1/.test(text)) {
      const r = rows.get(values[0] as string);
      return r ? [r] : [];
    }
    if (/INSERT INTO agent_runtimes/.test(text)) {
      const [userId, status, containerId, host, lastError] = values as [
        string,
        AgentRuntimeRow['status'],
        string | null,
        string | null,
        string | null,
      ];
      const prev = rows.get(userId) ?? {};
      rows.set(userId, {
        ...prev,
        user_id: userId,
        status,
        container_id: containerId ?? prev.container_id ?? null,
        host: host ?? prev.host ?? null,
        last_error: lastError,
      });
      return [];
    }
    return undefined;
  };
  return { rows, ...makeMockPool(responder) };
}

describe('Orchestrator', () => {
  let secretsDir: string;
  let secrets: SecretsWriter;

  beforeEach(async () => {
    secretsDir = await mkdtemp(path.join(tmpdir(), 'll5-orch-'));
    secrets = new SecretsWriter({ dir: secretsDir });
  });
  afterEach(async () => {
    await rm(secretsDir, { recursive: true, force: true });
  });

  function build(db: ReturnType<typeof makeRuntimesDb>, config = baseConfig(), extra = {}) {
    const runtime = new MockRuntime('agent-host-test');
    const orch = new Orchestrator({
      runtime,
      pool: db.pool,
      encryptor: { encrypt, decrypt },
      secrets,
      config,
      ...extra,
    });
    return { runtime, orch };
  }

  it('provisionForUser decrypts the key, provisions, and upserts running', async () => {
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY) });
    const { runtime, orch } = build(db);

    const result = await orch.provisionForUser('user-1', AGENT_TOKEN);

    expect(result.status).toBe('running');
    expect(result.containerId).toBeTruthy();
    expect(runtime.count()).toBe(1);
    // upsert landed running
    expect(db.rows.get('user-1')?.status).toBe('running');
    expect(db.rows.get('user-1')?.container_id).toBe(result.containerId);
  });

  it('provision passes a spec with NO secret in argv — only the env-file path', async () => {
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY) });
    const { runtime, orch } = build(db);

    await orch.provisionForUser('user-1', AGENT_TOKEN);

    expect(runtime.provisionCalls).toHaveLength(1);
    const spec = runtime.provisionCalls[0];
    const serialized = JSON.stringify(spec);
    // The secrets must not appear anywhere in the spec the runtime receives.
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(AGENT_TOKEN);
    // It references the per-user env-file path + the read-only mount target.
    expect(spec.envFilePath).toContain('user-1.env');
    expect(spec.envFileTarget).toBe('/run/ll5/agent.env');
    expect(spec.labels['ll5.user_id']).toBe('user-1');
  });

  it('errors when no api_key credential exists and does not provision', async () => {
    const db = makeRuntimesDb({ ciphertext: undefined });
    const { runtime, orch } = build(db);

    await expect(orch.provisionForUser('user-1', AGENT_TOKEN)).rejects.toBeInstanceOf(
      MissingCredentialError,
    );
    expect(runtime.provisionCalls).toHaveLength(0);
  });

  it('enforces the per-host container cap', async () => {
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY), liveCount: 25 });
    const { runtime, orch } = build(db, baseConfig({ maxContainersPerHost: 25 }));

    await expect(orch.provisionForUser('user-new', AGENT_TOKEN)).rejects.toBeInstanceOf(
      CapacityError,
    );
    expect(runtime.provisionCalls).toHaveLength(0);
    // status set to error/capacity
    expect(db.rows.get('user-new')?.status).toBe('error');
    expect(db.rows.get('user-new')?.last_error).toBe('capacity');
  });

  it('stopForUser stops the runtime and marks stopped', async () => {
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY) });
    const { runtime, orch } = build(db);
    await orch.provisionForUser('user-1', AGENT_TOKEN);

    const res = await orch.stopForUser('user-1');

    expect(res.status).toBe('stopped');
    expect(runtime.stopCalls).toContain('user-1');
    expect(runtime.count()).toBe(0);
    expect(db.rows.get('user-1')?.status).toBe('stopped');
  });

  it('statusForUser returns the row scoped to user_id', async () => {
    const rows = new Map<string, Partial<AgentRuntimeRow>>([
      ['user-1', { user_id: 'user-1', status: 'running', container_id: 'c1' }],
    ]);
    const db = makeRuntimesDb({ rows });
    const { orch } = build(db);

    const row = await orch.statusForUser('user-1');
    expect(row?.user_id).toBe('user-1');
    expect(row?.status).toBe('running');

    // The SELECT was scoped by user_id = $1
    const sel = db.calls.find((c) =>
      /FROM agent_runtimes WHERE user_id = \$1/.test(c.text),
    );
    expect(sel).toBeTruthy();
    expect(sel?.values).toContain('user-1');

    expect(await orch.statusForUser('user-absent')).toBeNull();
  });

  it('reconcile marks stale-heartbeat running rows as error and restarts (with token)', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
    const rows = new Map<string, Partial<AgentRuntimeRow>>([
      ['user-1', { user_id: 'user-1', status: 'running', last_seen_at: old, container_id: 'c1' }],
    ]);
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY), rows });
    const { runtime, orch } = build(db, baseConfig({ heartbeatTimeoutSec: 180 }), {
      agentTokenResolver: async () => AGENT_TOKEN,
    });

    const res = await orch.reconcile();

    expect(res.stale).toContain('user-1');
    expect(res.restarted).toContain('user-1');
    expect(runtime.provisionCalls).toHaveLength(1);
  });

  it('reprovisionRunning re-provisions EVERY running row regardless of heartbeat or cooldown (DECISION-027 image roll)', async () => {
    const fresh = new Date(); // fresh heartbeat — reconcile would leave it alone
    const rows = new Map<string, Partial<AgentRuntimeRow>>([
      ['user-1', { user_id: 'user-1', status: 'running', last_seen_at: fresh, container_id: 'c1' }],
      ['user-2', { user_id: 'user-2', status: 'running', last_seen_at: fresh, container_id: 'c2' }],
      ['user-3', { user_id: 'user-3', status: 'stopped', last_seen_at: fresh, container_id: null }],
    ]);
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY), rows });
    const { runtime, orch } = build(db, baseConfig({ restartCooldownSec: 600 }), {
      agentTokenResolver: async (userId: string) => (userId === 'user-2' ? null : AGENT_TOKEN),
    });

    const res = await orch.reprovisionRunning();

    // user-1: rolled. user-2: no agent token → reported failed, not thrown. user-3: not running → untouched.
    expect(res.reprovisioned).toEqual(['user-1']);
    expect(res.failed).toEqual(['user-2']);
    expect(runtime.provisionCalls).toHaveLength(1);
    expect(runtime.provisionCalls[0].userId).toBe('user-1');
    expect(db.rows.get('user-1')?.status).toBe('running');
    expect(db.rows.get('user-3')?.status).toBe('stopped');

    // No cooldown: a second roll immediately re-provisions again.
    const again = await orch.reprovisionRunning();
    expect(again.reprovisioned).toEqual(['user-1']);
    expect(runtime.provisionCalls).toHaveLength(2);
  });

  it('reconcile honors the restart cooldown (anti-flap)', async () => {
    const old = new Date(Date.now() - 10 * 60 * 1000);
    const rows = new Map<string, Partial<AgentRuntimeRow>>([
      ['user-1', { user_id: 'user-1', status: 'running', last_seen_at: old, container_id: 'c1' }],
    ]);
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY), rows });
    const { runtime, orch } = build(db, baseConfig({ restartCooldownSec: 600 }), {
      agentTokenResolver: async () => AGENT_TOKEN,
    });

    // First reconcile restarts; provisioning flips the row to running again.
    await orch.reconcile();
    expect(runtime.provisionCalls).toHaveLength(1);

    // Make it stale again and reconcile within the cooldown window: no restart.
    rows.set('user-1', {
      user_id: 'user-1',
      status: 'running',
      last_seen_at: old,
      container_id: 'c1',
    });
    const res2 = await orch.reconcile();
    expect(res2.stale).toContain('user-1');
    expect(res2.restarted).not.toContain('user-1');
    expect(runtime.provisionCalls).toHaveLength(1); // unchanged
  });

  it('reconcile leaves fresh-heartbeat rows alone', async () => {
    const fresh = new Date(Date.now() - 5 * 1000);
    const rows = new Map<string, Partial<AgentRuntimeRow>>([
      ['user-1', { user_id: 'user-1', status: 'running', last_seen_at: fresh, container_id: 'c1' }],
    ]);
    const db = makeRuntimesDb({ ciphertext: encrypt(API_KEY, KEY), rows });
    const { orch } = build(db);

    const res = await orch.reconcile();
    expect(res.stale).toHaveLength(0);
    expect(res.restarted).toHaveLength(0);
  });
});
