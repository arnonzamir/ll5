/**
 * HTTP client for the connectors MCP's REST ingest route
 * (`POST /api/events`, docs/design/connectors.md, Section 3): body =
 * ConnectorEventInput, response = ConnectorEventAck. Same shape as
 * scheduler/google-calendar-client.ts; the bearer is a user-scoped ll5 token
 * minted from AUTH_SECRET (the mcp-health-monitor idiom) so the MCP derives
 * user_id from the request context, never from the body.
 *
 * Env: CONNECTORS_MCP_URL (default http://connectors:3000 — the MCPs all
 * listen on 3000 inside the stack), AUTH_SECRET.
 */
import { generateToken, type ConnectorEventAck, type ConnectorEventInput } from '@ll5/shared';

export const DEFAULT_CONNECTORS_MCP_URL = 'http://connectors:3000';

export interface ConnectorsClient {
  postEvent(userId: string, event: ConnectorEventInput): Promise<ConnectorEventAck>;
  baseUrl: string;
}

export function createConnectorsClient(opts: { baseUrl?: string; authSecret?: string; fetchImpl?: typeof fetch } = {}): ConnectorsClient {
  const baseUrl = opts.baseUrl ?? process.env.CONNECTORS_MCP_URL ?? DEFAULT_CONNECTORS_MCP_URL;
  const authSecret = opts.authSecret ?? process.env.AUTH_SECRET ?? '';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  return {
    baseUrl,
    async postEvent(userId, event) {
      if (!authSecret) throw new Error('AUTH_SECRET not set — cannot mint a token for the connectors MCP');
      const token = generateToken(userId, authSecret, 1, 'user');
      const res = await fetchImpl(new URL('/api/events', baseUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(event),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`connectors MCP /api/events returned ${res.status}: ${text.slice(0, 200)}`);
      }
      const ack = (await res.json()) as Partial<ConnectorEventAck>;
      if (typeof ack.id !== 'string' || typeof ack.created !== 'boolean') {
        throw new Error('connectors MCP /api/events returned an unexpected body');
      }
      return { id: ack.id, created: ack.created };
    },
  };
}
