import { Client, Pool } from 'pg';
import { logger } from './logger.js';
import { triggerAgent, getAgentSessionId } from './agent-trigger.js';

let listenerClient: Client | null = null;
let keepRunning = true;

/**
 * Starts a durable Postgres LISTEN connection for chat_messages.
 * Triggers the opencode agent exactly once for each committed inbound user message.
 */
export async function startAgentTriggerListener(pool: Pool) {
  if (!process.env.OPENCODE_SERVER_URL) {
    logger.info('[AgentTriggerListener] Not starting (OPENCODE_SERVER_URL not set)');
    return;
  }

  keepRunning = true;
  await connectAndListen(pool);
}

export async function stopAgentTriggerListener() {
  keepRunning = false;
  if (listenerClient) {
    await listenerClient.end().catch(() => {});
    listenerClient = null;
  }
}

async function connectAndListen(pool: Pool) {
  if (!keepRunning) return;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn('[AgentTriggerListener] No DATABASE_URL — listener not started');
    return;
  }

  const client = new Client({ connectionString });

  client.on('error', (err) => {
    logger.error('[AgentTriggerListener] Database connection error', { error: err.message });
    // Reconnect on error
    client.end().catch(() => {});
    if (keepRunning) {
      setTimeout(() => connectAndListen(pool), 2000);
    }
  });

  client.on('notification', (msg) => {
    if (msg.channel === 'chat_messages' && msg.payload) {
      handleNotification(pool, msg.payload).catch((err) => {
        logger.error('[AgentTriggerListener] Failed to handle notification', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  });

  try {
    await client.connect();
    await client.query('LISTEN chat_messages');
    listenerClient = client;
    logger.info('[AgentTriggerListener] Connected and listening');
  } catch (err) {
    logger.error('[AgentTriggerListener] Connection failed, retrying...', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (keepRunning) {
      setTimeout(() => connectAndListen(pool), 2000);
    }
  }
}

async function handleNotification(pool: Pool, payloadStr: string) {
  let payload: Record<string, any>;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    return;
  }

  if (
    payload.event === 'new_message' &&
    payload.direction === 'inbound' &&
    payload.role === 'user' &&
    payload.status === 'pending'
  ) {
    const sessionId = await getAgentSessionId(pool, payload.user_id);
    if (!sessionId) {
      logger.warn('[AgentTriggerListener] No agent session registered for inbound message', {
        messageId: payload.id,
        userId: payload.user_id,
      });
      return;
    }

    const metadata: any = {};
    if (payload.channel || payload.source) {
      metadata.source = {
        platform: payload.channel,
        ...(payload.source?.remote_jid ? { remote_jid: payload.source.remote_jid } : {}),
      };
    }
    
    // We do not set noReply here - it's a normal chat message.
    await triggerAgent(sessionId, {
      content: payload.content || '',
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    });
  }
}
