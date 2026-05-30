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

  it('writes a 0600 env-file with the 5 contract keys', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-1',
      agentToken: 'll5.agent.tok',
      anthropicApiKey: 'sk-ant-secret',
      gatewayUrl: 'https://ll5.noninoni.click',
      mcpBaseDomain: 'noninoni.click',
    });

    const st = await stat(userPath);
    // 0600 — owner read/write only.
    expect(st.mode & 0o777).toBe(0o600);

    const content = await readFile(userPath, 'utf8');
    expect(content).toContain('LL5_USER_ID=');
    expect(content).toContain('LL5_AGENT_TOKEN=');
    expect(content).toContain('ANTHROPIC_API_KEY=');
    expect(content).toContain('LL5_GATEWAY_URL=');
    expect(content).toContain('MCP_BASE_DOMAIN=');
    expect(content).toContain('sk-ant-secret');
  });

  it('escapes single quotes safely', async () => {
    const dir = await tmpDir();
    const w = new SecretsWriter({ dir });
    const userPath = await w.write({
      userId: 'user-2',
      agentToken: "tok'with'quote",
      anthropicApiKey: 'k',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
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
      anthropicApiKey: 'k',
      gatewayUrl: 'g',
      mcpBaseDomain: 'm',
    });
    await w.remove('user-3');
    await expect(stat(p)).rejects.toThrow();
  });
});
