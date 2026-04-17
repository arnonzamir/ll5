import { logger } from '../utils/logger.js';

export interface EvolutionSendResult {
  success: boolean;
  message_id: string | null;
}

export interface EvolutionChat {
  id: string;
  name: string;
  isGroup: boolean;
  isArchived: boolean;
  unreadCount: number;
  lastMessageTimestamp?: number;
}

export interface EvolutionContact {
  remoteJid: string;
  pushName: string | null;
}

export interface FindChatsResult {
  chats: EvolutionChat[];
  contacts: EvolutionContact[];
}

/**
 * HTTP client for Evolution API (WhatsApp gateway).
 */
export class EvolutionClient {
  constructor(
    private baseUrl: string,
    private instanceName: string,
    private apiKey: string,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      apikey: this.apiKey,
    };

    logger.debug('[EvolutionClient][request] Evolution API request', { method, url });

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      logger.error('[EvolutionClient][request] Evolution API error', {
        status: response.status,
        body: text,
      });
      throw new Error(`Evolution API error ${response.status}: ${text}`);
    }

    return (await response.json()) as T;
  }

  /**
   * Send a text message via Evolution API.
   */
  async sendText(
    to: string,
    message: string,
  ): Promise<EvolutionSendResult> {
    try {
      // Ensure the recipient has the @s.whatsapp.net or @g.us suffix
      const number = to.includes('@') ? to : `${to}@s.whatsapp.net`;

      const result = await this.request<{ key?: { id?: string } }>(
        'POST',
        `/message/sendText/${this.instanceName}`,
        {
          number,
          text: message,
        },
      );

      return {
        success: true,
        message_id: result?.key?.id ?? null,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error('[EvolutionClient][sendText] Evolution sendText failed', { error: errorMessage });
      return { success: false, message_id: null };
    }
  }

  /**
   * Fetch all chats from Evolution API.
   * Returns both processed chats and raw contacts for contact registry ingestion.
   */
  async findChats(): Promise<FindChatsResult> {
    // Fetch chats and contacts in parallel
    const [chats, rawContacts] = await Promise.all([
      this.request<
        Array<{
          id: string;
          name?: string | null;
          pushName?: string | null;
          subject?: string | null;
          remoteJid?: string | null;
          isGroup?: boolean;
          archive?: boolean;
          archived?: boolean;
          unreadCount?: number;
          lastMessageTimestamp?: number;
        }>
      >('POST', `/chat/findChats/${this.instanceName}`, {}),
      this.request<
        Array<{
          remoteJid?: string | null;
          pushName?: string | null;
        }>
      >('POST', `/chat/findContacts/${this.instanceName}`, { where: {} }).catch(() => [] as Array<{ remoteJid?: string | null; pushName?: string | null }>),
    ]);

    // Build a JID → name lookup from contacts
    const contactNames = new Map<string, string>();
    for (const c of rawContacts || []) {
      if (c.remoteJid && c.pushName) {
        contactNames.set(c.remoteJid, c.pushName);
      }
    }

    const processedChats = (chats || [])
      .filter((chat) => chat.remoteJid || chat.id)
      .map((chat) => {
        const jid = chat.remoteJid || chat.id;
        const displayName = chat.name || chat.pushName || chat.subject || contactNames.get(jid) || jid;
        return {
          id: jid,
          name: displayName,
          isGroup: chat.isGroup ?? jid.endsWith('@g.us'),
          isArchived: chat.archive ?? chat.archived ?? false,
          unreadCount: chat.unreadCount ?? 0,
          lastMessageTimestamp: chat.lastMessageTimestamp,
        };
      });

    // Normalize raw contacts for the contact registry
    const contacts: EvolutionContact[] = (rawContacts || [])
      .filter((c): c is { remoteJid: string; pushName?: string | null } => !!c.remoteJid)
      .map((c) => ({
        remoteJid: c.remoteJid,
        pushName: c.pushName ?? null,
      }));

    return { chats: processedChats, contacts };
  }

  /**
   * Check instance connection status.
   */
  async connectionState(): Promise<{ state: string }> {
    try {
      const result = await this.request<{ instance?: { state?: string } }>(
        'GET',
        `/instance/connectionState/${this.instanceName}`,
      );
      return { state: result?.instance?.state ?? 'unknown' };
    } catch (err) {
      logger.warn('[evolution] connectionState check failed', { error: err instanceof Error ? err.message : String(err) });
      return { state: 'disconnected' };
    }
  }

  /**
   * Restart the Evolution instance. Used to recover from Baileys "ghost
   * connected" sessions where connectionState reports open but the WhatsApp
   * Web socket has silently desynced and no messages arrive.
   */
  async restart(): Promise<{ state: string }> {
    const result = await this.request<{ instance?: { state?: string } }>(
      'POST',
      `/instance/restart/${this.instanceName}`,
    );
    return { state: result?.instance?.state ?? 'unknown' };
  }

  /**
   * Fetch all messages with pagination (for backfill).
   * Uses POST /chat/findMessages with empty where clause.
   */
  async fetchMessagesPaginated(
    page: number = 1,
    limit: number = 500,
  ): Promise<{
    total: number;
    pages: number;
    currentPage: number;
    records: Array<{
      key: { remoteJid: string; fromMe: boolean; participant?: string; participantAlt?: string };
      pushName?: string;
      messageTimestamp?: number;
    }>;
  }> {
    const result = await this.request<{
      messages?: {
        total: number;
        pages: number;
        currentPage: number;
        records: Array<Record<string, unknown>>;
      };
    }>('POST', `/chat/findMessages/${this.instanceName}`, {
      where: {},
      limit,
      page,
    });

    const msgs = result?.messages ?? { total: 0, pages: 0, currentPage: page, records: [] };
    return msgs as any;
  }

  /**
   * Fetch recent messages for a chat.
   */
  async fetchMessages(
    chatId: string,
    limit: number = 20,
  ): Promise<
    Array<{
      key: { id: string; fromMe: boolean; remoteJid: string };
      pushName?: string;
      message?: { conversation?: string; extendedTextMessage?: { text?: string } };
      messageTimestamp?: number;
      contextInfo?: { quotedMessage?: unknown; stanzaId?: string };
    }>
  > {
    const result = await this.request<{ messages?: Array<Record<string, unknown>> }>(
      'POST',
      `/chat/findMessages/${this.instanceName}`,
      {
        where: {
          key: { remoteJid: chatId },
        },
        limit,
      },
    );

    // Evolution API v2 may return { messages: [...] } or a raw array or other shapes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = result?.messages ?? (Array.isArray(result) ? result : []);
    return messages as any;
  }
}
