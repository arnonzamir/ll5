import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { getAdapter, listAdapters } from '../clients/registry.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { logger } from '../utils/logger.js';

export function registerSourceTools(
  server: McpServer,
  pool: Pool,
  getUserId: () => string,
  encryptionKey: string,
): void {
  server.tool(
    'connect_health_source',
    'Connect a health data source (e.g. Garmin). Authenticates with the source and stores encrypted credentials.',
    {
      source_id: z.string().describe('Source identifier, e.g. "garmin"'),
      credentials: z.record(z.string()).describe('Source-specific credentials (e.g. { email, password } for Garmin)'),
    },
    async (params) => {
      const userId = getUserId();
      const adapter = getAdapter(params.source_id);

      if (!adapter) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown health source: ${params.source_id}. Available: ${listAdapters().map((a) => a.sourceId).join(', ')}` }) }],
          isError: true,
        };
      }

      try {
        await adapter.connect(userId, params.credentials);

        // Store encrypted credentials
        const encryptedCreds = encrypt(JSON.stringify(params.credentials), encryptionKey);
        await pool.query(
          `INSERT INTO health_source_credentials (user_id, source_id, credentials, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (user_id, source_id)
           DO UPDATE SET credentials = $3, updated_at = now()`,
          [userId, params.source_id, encryptedCreds],
        );

        logger.info('[connect_health_source] Source connected', { userId, sourceId: params.source_id });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, source: params.source_id, message: `${adapter.displayName} connected successfully` }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[connect_health_source] Connection failed', { userId, sourceId: params.source_id, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to connect ${adapter.displayName}: ${message}` }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'disconnect_health_source',
    'Disconnect a health data source and remove stored credentials.',
    {
      source_id: z.string().describe('Source identifier, e.g. "garmin"'),
    },
    async (params) => {
      const userId = getUserId();
      const adapter = getAdapter(params.source_id);

      if (!adapter) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown health source: ${params.source_id}` }) }],
          isError: true,
        };
      }

      try {
        await adapter.disconnect(userId);

        await pool.query(
          'DELETE FROM health_source_credentials WHERE user_id = $1 AND source_id = $2',
          [userId, params.source_id],
        );

        logger.info('[disconnect_health_source] Source disconnected', { userId, sourceId: params.source_id });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, source: params.source_id, message: `${adapter.displayName} disconnected` }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('[disconnect_health_source] Disconnect failed', { userId, sourceId: params.source_id, error: message });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Failed to disconnect ${adapter.displayName}: ${message}` }) }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'get_health_source_status',
    'Check the connection status of a health data source.',
    {
      source_id: z.string().describe('Source identifier, e.g. "garmin"'),
    },
    async (params) => {
      const userId = getUserId();
      const adapter = getAdapter(params.source_id);

      if (!adapter) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: `Unknown health source: ${params.source_id}` }) }],
          isError: true,
        };
      }

      // Check if we have stored credentials
      const result = await pool.query(
        'SELECT credentials, updated_at FROM health_source_credentials WHERE user_id = $1 AND source_id = $2',
        [userId, params.source_id],
      );

      if (result.rows.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ source: params.source_id, displayName: adapter.displayName, connected: false }) }],
        };
      }

      try {
        // Restore adapter connection from stored credentials
        const storedCreds = JSON.parse(decrypt(result.rows[0].credentials, encryptionKey));
        await adapter.connect(userId, storedCreds);
        const status = await adapter.getStatus(userId);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ source: params.source_id, displayName: adapter.displayName, ...status, lastCredentialUpdate: result.rows[0].updated_at }) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ source: params.source_id, displayName: adapter.displayName, connected: false, error: message }) }],
        };
      }
    },
  );

  server.tool(
    'list_health_sources',
    'List all available health data sources with their connection status.',
    {},
    async () => {
      const userId = getUserId();
      const adapters = listAdapters();

      // Fetch all stored credentials for this user
      const result = await pool.query(
        'SELECT source_id, updated_at FROM health_source_credentials WHERE user_id = $1',
        [userId],
      );
      const connectedSources = new Map(
        result.rows.map((r: { source_id: string; updated_at: string }) => [r.source_id, r.updated_at]),
      );

      const sources = adapters.map((adapter) => ({
        sourceId: adapter.sourceId,
        displayName: adapter.displayName,
        connected: connectedSources.has(adapter.sourceId),
        lastCredentialUpdate: connectedSources.get(adapter.sourceId) ?? null,
      }));

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sources }) }],
      };
    },
  );
}
