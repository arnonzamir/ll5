/**
 * HTTP client for the connectors MCP's REST routes
 * (docs/design/connectors.md, Section 3):
 *   POST /api/events  body = ConnectorEventInput, response = ConnectorEventAck
 *   POST /api/sync    body = { connector_id, scheduled }, response = SyncResult
 * Same shape as scheduler/google-calendar-client.ts; the bearer is a user-scoped
 * ll5 token minted from AUTH_SECRET (the mcp-health-monitor idiom) so the MCP
 * derives user_id from the request context, never from the body.
 *
 * Env: CONNECTORS_MCP_URL (default http://connectors:3000 — the MCPs all
 * listen on 3000 inside the stack), AUTH_SECRET.
 */
import { generateToken, type ConnectorEventAck, type ConnectorEventInput } from '@ll5/shared';

export const DEFAULT_CONNECTORS_MCP_URL = 'http://connectors:3000';

/** The connectors service's SyncResult, as far as the gateway reads it. */
export interface ConnectorSyncResponse {
  ok: boolean;
  connector_id: string;
  /** Present on refusals and failures: not_due | disabled | no_credentials | no_adapter | rate_limited | unknown_connector | pull_failed */
  reason?: string;
  /** On pull_failed: auth_failed | error */
  status?: string;
  /** On pull_failed: machine-readable cause, e.g. plan_not_eligible */
  code?: string;
  error?: string;
  pulled?: number;
  inserted?: number;
  updated?: number;
  retry_after_seconds?: number;
}

export interface ConnectorsClient {
  postEvent(userId: string, event: ConnectorEventInput): Promise<ConnectorEventAck>;
  /** Ask the service to run one pull; `scheduled` engages the service's due gate. */
  postSync(userId: string, connectorId: string, opts?: { scheduled?: boolean }): Promise<ConnectorSyncResponse>;
  baseUrl: string;
}

export function createConnectorsClient(opts: { baseUrl?: string; authSecret?: string; fetchImpl?: typeof fetch } = {}): ConnectorsClient {
  const baseUrl = opts.baseUrl ?? process.env.CONNECTORS_MCP_URL ?? DEFAULT_CONNECTORS_MCP_URL;
  const authSecret = opts.authSecret ?? process.env.AUTH_SECRET ?? '';
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  function mintToken(userId: string): string {
    if (!authSecret) throw new Error('AUTH_SECRET not set — cannot mint a token for the connectors MCP');
    return generateToken(userId, authSecret, 1, 'user');
  }

  return {
    baseUrl,
    async postEvent(userId, event) {
      const token = mintToken(userId);
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
    async postSync(userId, connectorId, syncOpts = {}) {
      const token = mintToken(userId);
      const res = await fetchImpl(new URL('/api/sync', baseUrl).toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ connector_id: connectorId, scheduled: syncOpts.scheduled === true }),
      });
      // 200 carries both ok:true and structured refusals; 404 = unknown_connector (also structured).
      if (res.status !== 200 && res.status !== 404) {
        const text = await res.text().catch(() => '');
        throw new Error(`connectors MCP /api/sync returned ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as Partial<ConnectorSyncResponse>;
      if (typeof body.ok !== 'boolean') throw new Error('connectors MCP /api/sync returned an unexpected body');
      return { ...body, ok: body.ok, connector_id: body.connector_id ?? connectorId };
    },
  };
}
