/**
 * Live-stack MCP contract tests (DECISION-029, 2026-09-05). READ-ONLY.
 *
 * Why these exist: on 2026-09-05 the messaging MCP returned [] for every WhatsApp
 * conversation for weeks (Evolution v2 response envelope, ISS-028) while 89 unit
 * tests passed — they mocked the response in the shape the code assumed. The only
 * test that catches that class of bug talks to the real dependency. So: one
 * `tools/list` and one real read per MCP, against the deployed stack, asserting
 * the RESPONSE SHAPE the agent relies on. No writes, no sends.
 *
 * Runs in CI after every deploy (job `e2e`) with LL5_E2E_TOKEN = a long-lived
 * agent token (the same kind the in-container agent uses). Locally:
 *   LL5_E2E_TOKEN=... npx vitest run --root packages/e2e
 * Skips entirely (not fails) when the token is absent so a fork/PR without
 * secrets stays green.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TOKEN = process.env.LL5_E2E_TOKEN ?? '';
const BASE_DOMAIN = process.env.MCP_BASE_DOMAIN ?? 'noninoni.click';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENDPOINTS = JSON.parse(
  readFileSync(path.join(HERE, '../../ll5-run-shared/mcp-endpoints.json'), 'utf8'),
) as { endpoints: Record<string, { subdomain: string; path: string }> };

const url = (mcp: string) => {
  const e = ENDPOINTS.endpoints[mcp];
  if (!e) throw new Error(`mcp-endpoints.json has no entry for ${mcp}`);
  return `https://${e.subdomain}.${BASE_DOMAIN}${e.path}`;
};

type ToolResult = { isError?: boolean; content?: Array<{ type: string; text?: string }> };

/** One JSON-RPC call over streamable HTTP; accepts both plain JSON and SSE replies. */
async function rpc(mcp: string, method: string, params: unknown): Promise<unknown> {
  const res = await fetch(url(mcp), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'User-Agent': 'll5-e2e/1.0',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(res.status, `${mcp} ${method} HTTP status`).toBe(200);
  const raw = await res.text();
  const line = raw.split('\n').find((l) => l.startsWith('data:'));
  const body = JSON.parse(line ? line.slice(5).trim() : raw) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${mcp} ${method}: ${body.error.message}`);
  return body.result;
}

async function listTools(mcp: string): Promise<string[]> {
  const r = (await rpc(mcp, 'tools/list', {})) as { tools: Array<{ name: string }> };
  return r.tools.map((t) => t.name);
}

async function call<T = unknown>(mcp: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: T; text: string }> {
  const r = (await rpc(mcp, 'tools/call', { name, arguments: args })) as ToolResult;
  const text = r.content?.[0]?.text ?? '';
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* non-JSON tool text */ }
  return { isError: Boolean(r.isError), data: data as T, text };
}

/** First array-valued property of a tool's JSON reply (tools differ in the key they use). */
function firstArray(obj: unknown): unknown[] | null {
  if (Array.isArray(obj)) return obj; // some tools (google list_events) reply with a bare array
  if (!obj || typeof obj !== 'object') return null;
  for (const v of Object.values(obj as Record<string, unknown>)) if (Array.isArray(v)) return v;
  return null;
}

const d = TOKEN ? describe : describe.skip;

d('MCP contracts (live, read-only)', () => {
  it('awareness: tools/list and read_journal return the agent-facing shape', async () => {
    expect((await listTools('awareness')).length).toBeGreaterThan(10);
    const r = await call('awareness', 'read_journal', { limit: 3 });
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    const rows = firstArray(r.data);
    expect(rows, 'read_journal must return an array of entries').not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
  });

  it('personal-knowledge: list_narratives returns narratives', async () => {
    expect((await listTools('personal-knowledge')).length).toBeGreaterThan(10);
    const r = await call('personal-knowledge', 'list_narratives', { limit: 3 });
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    const rows = firstArray(r.data);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
  });

  it('gtd: list_actions returns actions', async () => {
    expect((await listTools('gtd')).length).toBeGreaterThan(10);
    const r = await call('gtd', 'list_actions', {});
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    const rows = firstArray(r.data);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBeGreaterThan(0);
  });

  it('google: list_events answers without error (a day may legitimately be empty)', async () => {
    expect((await listTools('google')).length).toBeGreaterThan(5);
    const r = await call('google', 'list_events', {});
    // A disconnected OAuth is a real, separately-alerted condition — report it as such.
    expect(r.isError, `list_events error: ${r.text.slice(0, 200)}`).toBe(false);
    expect(firstArray(r.data), 'list_events must return an events array').not.toBeNull();
  });

  it('messaging: read_messages on a real WhatsApp conversation returns messages (ISS-028 guard)', async () => {
    expect((await listTools('messaging')).length).toBeGreaterThan(5);
    const convs = await call<{ conversations?: Array<{ conversation_id: string }> }>('messaging', 'list_conversations', { platform: 'whatsapp', limit: 3 });
    expect(convs.isError, convs.text.slice(0, 200)).toBe(false);
    const list = firstArray(convs.data) as Array<{ conversation_id: string }> | null;
    expect(list, 'list_conversations must return an array').not.toBeNull();
    expect(list!.length, 'the account has conversations — none listed').toBeGreaterThan(0);

    const r = await call<{ messages?: Array<{ timestamp?: string; content?: string }>; error?: string }>(
      'messaging', 'read_messages', { platform: 'whatsapp', conversation_id: list![0].conversation_id, limit: 3 },
    );
    if (r.isError && r.data?.error === 'ACCOUNT_DISCONNECTED') {
      // The bridge stall (ISS-013) has its own alert; this test is about the read path.
      console.warn('messaging: WhatsApp account disconnected during the run — read-path check skipped');
      return;
    }
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    expect(Array.isArray(r.data?.messages), 'read_messages must return { messages: [...] }').toBe(true);
    expect(r.data!.messages!.length, 'read_messages returned [] for a live conversation — the ISS-028 failure').toBeGreaterThan(0);
    expect(typeof r.data!.messages![0].timestamp).toBe('string');
  });

  it('connectors: list_connectors returns the catalog joined with per-user state', async () => {
    const tools = await listTools('connectors');
    expect(tools.sort()).toEqual([
      'get_connector_digest', 'ingest_ledger_rows', 'list_connectors', 'query_events',
      'query_ledger', 'resolve_finding', 'submit_otp', 'sync_connector',
    ]);
    const r = await call<{ connectors?: Array<{ id: string; enabled: boolean; status: string; has_credentials: boolean }> }>('connectors', 'list_connectors', {});
    expect(r.isError, r.text.slice(0, 200)).toBe(false);
    expect(Array.isArray(r.data?.connectors), 'list_connectors must return { connectors: [...] }').toBe(true);
    const ids = r.data!.connectors!.map((c) => c.id);
    for (const id of ['cal', 'max', 'isracard', 'bank', 'paybox', 'clalit', 'iec', 'water', 'home-assistant', 'financy']) expect(ids).toContain(id);
    expect(typeof r.data!.connectors![0].enabled).toBe('boolean');
    expect(typeof r.data!.connectors![0].status).toBe('string');
    expect(typeof r.data!.connectors![0].has_credentials).toBe('boolean');
  });
});
