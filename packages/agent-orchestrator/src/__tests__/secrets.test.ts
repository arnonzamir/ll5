import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecretsWriter, type AgentModelConfig } from '../secrets.js';

const cfg = (over: Partial<AgentModelConfig> = {}): AgentModelConfig => ({
  default: { provider: 'zen', model: 'deepseek-v4-flash' },
  slots: {},
  ...over,
});

describe('SecretsWriter', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const d of created) await rm(d, { recursive: true, force: true });
    created.length = 0;
  });

  async function tmpDir(): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'll5-secrets-'));
    created.push(d);
    return d;
  }

  it('writes a 0600 anthropic (legacy Claude variant) env-file with the contract keys', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-1',
      agentToken: 'll5.agent.tok',
      gatewayUrl: 'https://ll5.noninoni.click',
      mcpBaseDomain: 'noninoni.click',
      provider: 'anthropic',
      keys: { anthropic: 'sk-ant-secret' },
      config: cfg({ default: { provider: 'anthropic', model: 'claude-haiku-4-5' } }),
    });

    const st = await stat(userPath);
    expect(st.mode & 0o777).toBe(0o600);

    const content = await readFile(userPath, 'utf8');
    expect(content).toContain('LL5_USER_ID=');
    expect(content).toContain(`AGENT_VARIANT='claude'`);
    expect(content).toContain(`ANTHROPIC_API_KEY='sk-ant-secret'`);
    expect(content).not.toContain('OPENCODE_ZEN_API_KEY');
  });

  it('writes an opencode env-file with keys + abstract default/main', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-oc',
      agentToken: 'tok',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
      provider: 'opencode',
      keys: { zen: 'zen-key-123' },
      config: cfg(),
    });
    const content = await readFile(userPath, 'utf8');
    expect(content).toContain(`AGENT_VARIANT='opencode'`);
    expect(content).toContain(`OPENCODE_ZEN_API_KEY='zen-key-123'`);
    expect(content).toContain(`LL5_DEFAULT_PROVIDER='zen'`);
    expect(content).toContain(`LL5_DEFAULT_MODEL='deepseek-v4-flash'`);
    expect(content).toContain(`LL5_SLOT_MAIN_PROVIDER='zen'`);
    expect(content).toContain(`LL5_SLOT_MAIN_MODEL='deepseek-v4-flash'`);
    expect(content).not.toContain('ANTHROPIC_API_KEY');
  });

  it('emits per-slot provider+model for set slots only, across providers', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const p = await w.write({
      userId: 'user-oc-slots', agentToken: 't', gatewayUrl: 'g', mcpBaseDomain: 'm',
      provider: 'opencode',
      keys: { zen: 'zk', groq: 'gk', anthropic: 'ak' },
      config: cfg({
        slots: {
          narrative: { provider: 'anthropic', model: 'claude-haiku-4-5' },
          image: { provider: 'zen', model: 'claude-haiku-4-5' },
          audio: { provider: 'groq', model: 'whisper-large-v3' },
        },
      }),
    });
    const content = await readFile(p, 'utf8');
    expect(content).toContain(`GROQ_API_KEY='gk'`);
    expect(content).toContain(`ANTHROPIC_API_KEY='ak'`);
    expect(content).toContain(`LL5_SLOT_NARRATIVE_PROVIDER='anthropic'`);
    expect(content).toContain(`LL5_SLOT_NARRATIVE_MODEL='claude-haiku-4-5'`);
    expect(content).toContain(`LL5_SLOT_AUDIO_PROVIDER='groq'`);
    expect(content).toContain(`LL5_SLOT_AUDIO_MODEL='whisper-large-v3'`);
    expect(content).not.toContain('LL5_SLOT_RECONCILE_'); // not set → inherits
  });

  it('main slot override wins over default for LL5_SLOT_MAIN_*', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const p = await w.write({
      userId: 'user-main', agentToken: 't', gatewayUrl: 'g', mcpBaseDomain: 'm',
      provider: 'opencode', keys: { zen: 'k', groq: 'g' },
      config: cfg({ slots: { main: { provider: 'groq', model: 'moonshotai/kimi-k2-instruct' } } }),
    });
    const content = await readFile(p, 'utf8');
    expect(content).toContain(`LL5_SLOT_MAIN_PROVIDER='groq'`);
    expect(content).toContain(`LL5_SLOT_MAIN_MODEL='moonshotai/kimi-k2-instruct'`);
    expect(content).toContain(`LL5_DEFAULT_PROVIDER='zen'`); // default unchanged
  });

  it('escapes single quotes safely', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-2', agentToken: "tok'with'quote", gatewayUrl: 'g', mcpBaseDomain: 'm',
      provider: 'anthropic', keys: { anthropic: 'k' }, config: cfg(),
    });
    const content = await readFile(userPath, 'utf8');
    expect(content).toContain(`LL5_AGENT_TOKEN='tok'\\''with'\\''quote'`);
  });

  it('removes the env-file', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const p = await w.write({
      userId: 'user-3', agentToken: 't', gatewayUrl: 'g', mcpBaseDomain: 'm',
      provider: 'anthropic', keys: { anthropic: 'k' }, config: cfg(),
    });
    await w.remove('user-3');
    await expect(stat(p)).rejects.toThrow();
  });
});
