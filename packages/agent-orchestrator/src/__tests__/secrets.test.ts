import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SecretsWriter } from '../secrets.js';

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

  it('writes a 0600 anthropic env-file with the contract keys', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-1',
      agentToken: 'll5.agent.tok',
      apiKey: 'sk-ant-secret',
      gatewayUrl: 'https://ll5.noninoni.click',
      mcpBaseDomain: 'noninoni.click',
      provider: 'anthropic',
    });

    const st = await stat(userPath);
    expect(st.mode & 0o777).toBe(0o600);

    const content = await readFile(userPath, 'utf8');
    expect(content).toContain('LL5_USER_ID=');
    expect(content).toContain('LL5_AGENT_TOKEN=');
    expect(content).toContain('LL5_GATEWAY_URL=');
    expect(content).toContain('MCP_BASE_DOMAIN=');
    expect(content).toContain(`AGENT_VARIANT='claude'`);
    expect(content).toContain('ANTHROPIC_API_KEY=');
    expect(content).toContain('sk-ant-secret');
    // No opencode keys leak into an anthropic file.
    expect(content).not.toContain('OPENCODE_ZEN_API_KEY');
  });

  it('writes an opencode env-file with variant/model/key/url', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-oc',
      agentToken: 'tok',
      apiKey: 'zen-key-123',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
      provider: 'opencode',
      model: 'deepseek-v4-flash-free',
      baseUrl: 'http://agent:4096',
    });
    const content = await readFile(userPath, 'utf8');
    expect(content).toContain(`AGENT_VARIANT='opencode'`);
    expect(content).toContain(`OPENCODE_ZEN_API_KEY='zen-key-123'`);
    expect(content).toContain(`OPENCODE_PROVIDER_ID='opencode'`);
    expect(content).toContain(`OPENCODE_MODEL_ID='deepseek-v4-flash-free'`);
    expect(content).toContain(`OPENCODE_SERVER_URL='http://agent:4096'`);
    expect(content).not.toContain('ANTHROPIC_API_KEY');
  });

  it('opencode without model/baseUrl omits those lines', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const p = await w.write({
      userId: 'user-oc2', agentToken: 't', apiKey: 'k', gatewayUrl: 'g',
      mcpBaseDomain: 'm', provider: 'opencode',
    });
    const content = await readFile(p, 'utf8');
    expect(content).toContain('OPENCODE_ZEN_API_KEY=');
    expect(content).not.toContain('OPENCODE_MODEL_ID=');
    expect(content).not.toContain('OPENCODE_SERVER_URL=');
  });

  it('escapes single quotes safely', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-2',
      agentToken: "tok'with'quote",
      apiKey: 'k',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
      provider: 'anthropic',
    });
    const content = await readFile(userPath, 'utf8');
    expect(content).toContain(`LL5_AGENT_TOKEN='tok'\\''with'\\''quote'`);
  });

  it('removes the env-file', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const p = await w.write({
      userId: 'user-3',
      agentToken: 't',
      apiKey: 'k',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
      provider: 'anthropic',
    });
    await w.remove('user-3');
    await expect(stat(p)).rejects.toThrow();
  });
});
