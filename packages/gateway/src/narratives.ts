import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { chatAuthMiddleware } from './chat.js';
import { insertSystemMessage, createSchedulerEvent } from './utils/system-message.js';
import { logger } from './utils/logger.js';

const MCP_TIMEOUT_MS = 8000;
const SUBJECT_KINDS = ['person', 'place', 'group', 'topic'] as const;

/**
 * Call a personal-knowledge MCP tool, forwarding the CALLER's bearer token so the
 * MCP scopes to the right user (multi-tenant-safe). Connects per request (cheap;
 * mirrors the MCP health probe), returns the parsed JSON of the first text content.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function callKnowledge(
  baseUrl: string,
  authHeader: string,
  tool: string,
  args: Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const mcpUrl = `${baseUrl.replace(/\/$/, '')}/mcp`;
  let client: McpClient | null = null;
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: authHeader } },
    });
    client = new McpClient({ name: 'll5-gateway-narratives', version: '0.1.0' }, { capabilities: {} });
    await Promise.race([
      client.connect(transport),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${MCP_TIMEOUT_MS}ms`)), MCP_TIMEOUT_MS)),
    ]);
    const res = await Promise.race([
      client.callTool({ name: tool, arguments: args }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`mcp_timeout_${MCP_TIMEOUT_MS}ms`)), MCP_TIMEOUT_MS)),
    ]);
    const content = res.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

/**
 * Read-only narratives API for the web dashboard + mobile app — one auth surface
 * (Bearer ll5 token → caller's user_id) proxying the personal-knowledge MCP. List
 * is relevance-sorted; detail bundles the observation timeline + the connection
 * map; summarize fires an EPHEMERAL agent summary (does not mutate the narrative).
 */
export function createNarrativesRouter(pool: Pool, authSecret: string, knowledgeMcpUrl: string): Router {
  const router = Router();
  const authMw = chatAuthMiddleware(authSecret);

  // GET /narratives — relevance- (default) or recency-sorted list + search.
  router.get('/narratives', authMw, async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (!auth) return void res.status(401).json({ error: 'missing authorization' });
    try {
      const { status, sort, q, subject_kind, limit, offset } = req.query;
      const out = await callKnowledge(knowledgeMcpUrl, auth, 'list_narratives', {
        status: typeof status === 'string' ? status : 'active',
        sort: sort === 'recency' ? 'recency' : 'relevance',
        query: typeof q === 'string' && q ? q : undefined,
        subject_kind: typeof subject_kind === 'string' ? subject_kind : undefined,
        limit: limit ? Math.min(Number(limit) || 50, 200) : 50,
        offset: offset ? Number(offset) || 0 : 0,
      });
      res.json({ narratives: out?.narratives ?? [], total: out?.total ?? 0 });
    } catch (err) {
      logger.error('[narratives][list] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'Failed to load narratives.' });
    }
  });

  // GET /narratives/detail?kind=&ref= — narrative + observation timeline + connections.
  router.get('/narratives/detail', authMw, async (req: Request, res: Response) => {
    const auth = req.headers.authorization;
    if (!auth) return void res.status(401).json({ error: 'missing authorization' });
    const kind = String(req.query.kind ?? '');
    const ref = String(req.query.ref ?? '');
    if (!SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number]) || !ref) {
      return void res.status(400).json({ error: 'valid kind (person|place|group|topic) and ref required' });
    }
    const subject = { kind, ref };
    try {
      const [detail, connections] = await Promise.all([
        callKnowledge(knowledgeMcpUrl, auth, 'get_narrative', { subject, observation_limit: 60 }),
        callKnowledge(knowledgeMcpUrl, auth, 'get_narrative_connections', { subject }),
      ]);
      res.json({
        narrative: detail?.narrative ?? null,
        observations: detail?.observations ?? [],
        connections: connections ?? { subject, entities: [], related: [] },
      });
    } catch (err) {
      logger.error('[narratives][detail] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(502).json({ error: 'Failed to load narrative.' });
    }
  });

  // POST /narratives/summarize { kind, ref } — fire an EPHEMERAL point-in-time
  // agent summary. The agent replies it into the chat thread; it does NOT
  // upsert/overwrite the stored narrative. Returns event_id for UI correlation.
  router.post('/narratives/summarize', authMw, async (req: Request, res: Response) => {
    const userId = (req as Request & { userId: string }).userId;
    const { kind, ref } = (req.body ?? {}) as { kind?: string; ref?: string };
    if (!kind || !SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number]) || !ref) {
      return void res.status(400).json({ error: 'valid kind (person|place|group|topic) and ref required' });
    }
    try {
      const evt = createSchedulerEvent('narrative_summary_on_demand');
      const prompt = [
        `[Narrative Summary Request] The user opened the narrative ${kind}:${ref} and asked for a fresh point-in-time summary RIGHT NOW.`,
        `Load it — recall({ subjects:[{ kind:"${kind}", ref:"${ref}" }] }) and/or get_narrative({ subject:{ kind:"${kind}", ref:"${ref}" } }) — then push_to_user a concise 3–6 sentence summary of where this thread stands at THIS moment: what it is, current state, open threads, what to watch.`,
        `This is an EPHEMERAL snapshot for the UI — DO NOT call upsert_narrative or otherwise change the stored narrative.`,
      ].join(' ');
      const messageId = await insertSystemMessage(pool, userId, prompt, undefined, evt);
      res.json({ event_id: evt.event_id, message_id: messageId });
    } catch (err) {
      logger.error('[narratives][summarize] failed', { error: err instanceof Error ? err.message : String(err) });
      res.status(500).json({ error: 'Failed to request summary.' });
    }
  });

  return router;
}
