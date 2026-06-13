/**
 * Wraps McpServer.tool() to log every tool call:
 *  - app_log: a lightweight row (name/duration/success) for the log explorer.
 *  - audit ledger (DECISION-012 stage 3): a `kind:'tool_call'` row with the FULL
 *    input + output + correlation ids — the durable record the eval-replay cassette
 *    reads. Both are fire-and-forget and never affect the call.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logApp } from '../app-log.js';
import { logToolCall } from '../audit.js';

type ToolHandler = (...args: unknown[]) => Promise<unknown>;

/**
 * Wrap an McpServer so every tool call is logged.
 * Call this before registering tools.
 */
export function withToolLogging(
  server: McpServer,
  getUserId: () => string,
): McpServer {
  const originalTool = server.tool.bind(server);

  // Override server.tool to wrap each handler with logging
  (server as unknown as Record<string, unknown>).tool = function (
    name: string,
    ...rest: unknown[]
  ) {
    // server.tool has multiple overloads — the handler is always the last arg
    const args = [...rest];
    const handler = args[args.length - 1] as ToolHandler;

    args[args.length - 1] = async (...handlerArgs: unknown[]) => {
      const start = Date.now();
      const userId = getUserId();

      // The MCP SDK invokes the handler as (args, extra) — handlerArgs[0] is the
      // tool input the agent supplied.
      const toolArgs = handlerArgs[0];

      try {
        const result = await handler(...handlerArgs);
        const duration = Date.now() - start;

        logApp({
          level: duration > 5000 ? 'warn' : 'info',
          action: 'tool_call',
          message: `${name} completed in ${duration}ms`,
          tool_name: name,
          user_id: userId,
          duration_ms: duration,
          success: true,
        });
        // Complete ledger row: full input + output (DECISION-012 stage 3).
        logToolCall({
          tool_name: name,
          user_id: userId,
          args: toolArgs,
          result,
          duration_ms: duration,
          success: true,
        });

        return result;
      } catch (err) {
        const duration = Date.now() - start;
        const errorMessage = err instanceof Error ? err.message : String(err);

        logApp({
          level: 'error',
          action: 'tool_call',
          message: `${name} failed: ${errorMessage}`,
          tool_name: name,
          user_id: userId,
          duration_ms: duration,
          success: false,
          error_message: errorMessage,
        });
        logToolCall({
          tool_name: name,
          user_id: userId,
          args: toolArgs,
          duration_ms: duration,
          success: false,
          error_message: errorMessage,
        });

        throw err;
      }
    };

    return (originalTool as (...a: unknown[]) => unknown)(name, ...args);
  };

  return server;
}
