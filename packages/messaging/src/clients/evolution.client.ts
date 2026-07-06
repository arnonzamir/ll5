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
      // A successful HTTP response reflects the real WhatsApp link state
      // (e.g. 'open', 'connecting', 'close'). 'close' here is a genuine
      // logout/disconnect and is returned verbatim.
      return { state: result?.instance?.state ?? 'unknown' };
    } catch (err) {
      // A thrown error is a TRANSPORT failure (network blip, Evolution down,
      // 5xx) — NOT a WhatsApp logout. Returning 'disconnected' here would be a
      // silent error: callers could not distinguish "phone unlinked" from "we
      // couldn't reach Evolution", and would wrongly trigger re-pairing flows.
      // Surface it distinctly so callers can retry instead of re-pairing.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('[evolution] connectionState transient transport error', {
        instance: this.instanceName,
        error: message,
        transient: true,
      });
      return { state: 'transient_error' };
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
   * Request a fresh pairing QR code for an already-created instance.
   * POST /instance/connect/{instanceName}
   * Evolution returns { code: 'data:image/png;base64,...', pairingCode?: '...' }
   * or { base64: '...' } depending on version.
   */
  async connect(): Promise<{ base64: string | null; pairingCode: string | null }> {
    const result = await this.request<{
      code?: string;
      base64?: string;
      pairingCode?: string;
      qrcode?: { code?: string; base64?: string; pairingCode?: string };
    }>('GET', `/instance/connect/${this.instanceName}`);

    // Evolution v2 wraps in `qrcode`; older returns top-level
    const qr = result.qrcode ?? result;
    const base64 = (qr as { base64?: string }).base64 ?? (qr as { code?: string }).code ?? null;
    const pairingCode = (qr as { pairingCode?: string }).pairingCode ?? null;
    return { base64, pairingCode };
  }

  /**
   * Log the instance out of WhatsApp (revokes the linked-device slot). The
   * Evolution instance itself remains; a subsequent /instance/connect call
   * will produce a fresh QR.
   * DELETE /instance/logout/{instanceName}
   */
  async logout(): Promise<{ success: boolean }> {
    await this.request<unknown>('DELETE', `/instance/logout/${this.instanceName}`);
    return { success: true };
  }

  /**
   * Create a new Evolution instance with a webhook configured. This is the
   * one-time provisioning call; subsequent reconnects use /instance/connect.
   *
   * `globalApiKey` is the Evolution-wide AUTHENTICATION_API_KEY (NOT the
   * per-instance key). Evolution returns a per-instance `hash` (api_key) that
   * MUST be stored encrypted alongside the row.
   */
  static async createInstance(
    baseUrl: string,
    globalApiKey: string,
    config: {
      instanceName: string;
      webhookUrl: string;
      webhookSecret: string;
      events?: string[];
    },
  ): Promise<{
    instanceId: string;
    instanceName: string;
    apiKey: string;
    qrBase64: string | null;
    pairingCode: string | null;
  }> {
    const events = config.events ?? [
      'MESSAGES_UPSERT',
      'MESSAGES_UPDATE',
      'CONNECTION_UPDATE',
      'QRCODE_UPDATED',
      // Connection-lifecycle events so the gateway sees login/start/logout and
      // the agent can proactively surface a WhatsApp drop / QR-scan need (DECISION-024).
      'APPLICATION_STARTUP',
      'LOGOUT_INSTANCE',
      'REMOVE_INSTANCE',
      'CONTACTS_UPSERT',
      'CHATS_UPSERT',
      'CHATS_UPDATE',
      'CHATS_DELETE',
    ];

    const url = `${baseUrl}/instance/create`;
    const headers = {
      'Content-Type': 'application/json',
      apikey: globalApiKey,
    };
    const body = {
      instanceName: config.instanceName,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      webhook: {
        url: config.webhookUrl,
        byEvents: false,
        // base64:false — the gateway fetches media separately via
        // getBase64FromMediaMessage; inlining base64 media blew past the
        // gateway's 1MB body limit and 413-jammed the whole feed (DECISION-024,
        // the 2026-07-06 outage). This is the config a re-pair must NOT revert.
        base64: false,
        headers: { 'X-Webhook-Secret': config.webhookSecret },
        events,
      },
    };

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      logger.error('[EvolutionClient][createInstance] Evolution API error', {
        status: response.status,
        body: text,
      });
      throw new Error(`Evolution createInstance ${response.status}: ${text}`);
    }

    const raw = (await response.json()) as {
      instance?: { instanceId?: string; instanceName?: string };
      hash?: string | { apikey?: string };
      qrcode?: { code?: string; base64?: string; pairingCode?: string };
    };

    const instanceId = raw.instance?.instanceId ?? '';
    const instanceName = raw.instance?.instanceName ?? config.instanceName;
    const apiKey =
      typeof raw.hash === 'string'
        ? raw.hash
        : (raw.hash?.apikey ?? '');
    const qrBase64 = raw.qrcode?.base64 ?? raw.qrcode?.code ?? null;
    const pairingCode = raw.qrcode?.pairingCode ?? null;

    if (!apiKey) {
      throw new Error('Evolution createInstance returned no api key (hash)');
    }

    return { instanceId, instanceName, apiKey, qrBase64, pairingCode };
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
