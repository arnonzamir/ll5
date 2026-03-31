import { logger } from '../utils/logger.js';

export interface EvolutionSendResult {
  success: boolean;
  message_id: string | null;
}

export interface EvolutionChat {
  id: string;
  name: string;
  isGroup: boolean;
  lastMessageTimestamp?: number;
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

    logger.debug('Evolution API request', { method, url });

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      logger.error('Evolution API error', {
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
      logger.error('Evolution sendText failed', { error: errorMessage });
      return { success: false, message_id: null };
    }
  }

  /**
   * Fetch all chats from Evolution API.
   */
  async findChats(): Promise<EvolutionChat[]> {
    // Fetch chats and contacts in parallel
    const [chats, contacts] = await Promise.all([
      this.request<
        Array<{
          id: string;
          name?: string | null;
          pushName?: string | null;
          subject?: string | null;
          remoteJid?: string | null;
          isGroup?: boolean;
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
    for (const c of contacts || []) {
      if (c.remoteJid && c.pushName) {
        contactNames.set(c.remoteJid, c.pushName);
      }
    }

    return (chats || [])
      .filter((chat) => chat.remoteJid || chat.id)
      .map((chat) => {
        const jid = chat.remoteJid || chat.id;
        const displayName = chat.name || chat.pushName || chat.subject || contactNames.get(jid) || jid;
        return {
          id: jid,
          name: displayName,
          isGroup: chat.isGroup ?? jid.endsWith('@g.us'),
          lastMessageTimestamp: chat.lastMessageTimestamp,
        };
      });
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
    } catch {
      return { state: 'disconnected' };
    }
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result?.messages ?? result ?? []) as any;
  }
}
