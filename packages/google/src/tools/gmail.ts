import { z } from 'zod';
import { google } from 'googleapis';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OAuthTokenRepository } from '../repositories/interfaces/oauth-token.repository.js';
import { getAuthenticatedClient, type GoogleClientConfig } from '../utils/google-client.js';
import { logger } from '../utils/logger.js';

/**
 * Decode a base64url-encoded string.
 */
function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

/**
 * Encode a string to base64url.
 */
function encodeBase64Url(data: string): string {
  return Buffer.from(data, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Extract a header value from Gmail message headers.
 */
function getHeader(
  headers: Array<{ name?: string | null; value?: string | null }> | undefined,
  name: string,
): string {
  if (!headers) return '';
  const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value ?? '';
}

/**
 * Extract plain text body from Gmail message payload.
 */
function extractBody(payload: {
  mimeType?: string | null;
  body?: { data?: string | null } | null;
  parts?: Array<{
    mimeType?: string | null;
    body?: { data?: string | null } | null;
    parts?: Array<{
      mimeType?: string | null;
      body?: { data?: string | null } | null;
    }>;
  }>;
} | undefined): string {
  if (!payload) return '';

  // Direct body
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  // Multipart
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
      // Nested multipart
      if (part.parts) {
        for (const nested of part.parts) {
          if (nested.mimeType === 'text/plain' && nested.body?.data) {
            return decodeBase64Url(nested.body.data);
          }
        }
      }
    }
    // Fallback to HTML if no plain text
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
  }

  return '';
}

export function registerGmailTools(
  server: McpServer,
  tokenRepo: OAuthTokenRepository,
  config: GoogleClientConfig,
  getUserId: () => string,
): void {

  // ---------------------------------------------------------------------------
  // list_emails
  // ---------------------------------------------------------------------------
  server.tool(
    'list_emails',
    'List Gmail messages matching a search query, with optional label and date filtering.',
    {
      query: z.string().optional().describe('Gmail search query (same syntax as Gmail search bar)'),
      label: z.string().optional().describe('Filter by Gmail label (e.g., INBOX, SENT, STARRED)'),
      from: z.string().optional().describe('Only messages after this date (ISO 8601)'),
      to: z.string().optional().describe('Only messages before this date (ISO 8601)'),
      max_results: z.number().optional().describe('Max messages to return (default: 20)'),
      include_body: z.boolean().optional().describe('Include full message body (default: true)'),
    },
    async ({ query, label, from, to, max_results, include_body }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const gmail = google.gmail({ version: 'v1', auth });

      const maxResults = max_results ?? 20;
      const includeBody = include_body !== false;

      // Build Gmail search query
      const queryParts: string[] = [];
      if (query) queryParts.push(query);
      if (from) queryParts.push(`after:${from.split('T')[0]}`);
      if (to) queryParts.push(`before:${to.split('T')[0]}`);

      const q = queryParts.length > 0 ? queryParts.join(' ') : undefined;
      const labelIds = label ? [label] : undefined;

      const listResponse = await gmail.users.messages.list({
        userId: 'me',
        q,
        labelIds,
        maxResults,
      });

      const messageRefs = listResponse.data.messages ?? [];
      const emails: Record<string, unknown>[] = [];

      for (const ref of messageRefs) {
        if (!ref.id) continue;

        try {
          const msg = await gmail.users.messages.get({
            userId: 'me',
            id: ref.id,
            format: includeBody ? 'full' : 'metadata',
            metadataHeaders: includeBody ? undefined : ['From', 'To', 'Cc', 'Subject', 'Date'],
          });

          const headers = msg.data.payload?.headers ?? [];
          const fromHeader = getHeader(headers, 'From');
          const toHeader = getHeader(headers, 'To');
          const ccHeader = getHeader(headers, 'Cc');
          const subject = getHeader(headers, 'Subject');
          const date = getHeader(headers, 'Date');

          const labels = msg.data.labelIds ?? [];
          const isUnread = labels.includes('UNREAD');

          // Check for attachments
          const hasAttachments = (msg.data.payload?.parts ?? []).some(
            (p) => p.filename && p.filename.length > 0,
          );

          const body = includeBody ? extractBody(msg.data.payload ?? undefined) : null;

          emails.push({
            message_id: msg.data.id ?? '',
            thread_id: msg.data.threadId ?? '',
            from: fromHeader,
            to: toHeader ? toHeader.split(',').map((s) => s.trim()) : [],
            cc: ccHeader ? ccHeader.split(',').map((s) => s.trim()).filter(Boolean) : [],
            subject,
            date: date ? new Date(date).toISOString() : '',
            snippet: msg.data.snippet ?? '',
            body,
            labels,
            is_unread: isUnread,
            has_attachments: hasAttachments,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Failed to fetch message ${ref.id}`, { error: message });
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(emails, null, 2),
        }],
      };
    },
  );

  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.tool(
    'send_email',
    'Send an email via Gmail on behalf of the user.',
    {
      to: z.array(z.string()).describe('Recipient email addresses'),
      subject: z.string().describe('Email subject line'),
      body: z.string().describe('Email body (plain text)'),
      cc: z.array(z.string()).optional().describe('CC recipients'),
      bcc: z.array(z.string()).optional().describe('BCC recipients'),
      reply_to_message_id: z.string().optional().describe('Gmail message ID to reply to'),
    },
    async ({ to, subject, body, cc, bcc, reply_to_message_id }) => {
      const userId = getUserId();
      const auth = await getAuthenticatedClient(config, tokenRepo, userId);
      const gmail = google.gmail({ version: 'v1', auth });

      // Build RFC 2822 message
      const messageParts: string[] = [];
      messageParts.push(`To: ${to.join(', ')}`);
      if (cc && cc.length > 0) messageParts.push(`Cc: ${cc.join(', ')}`);
      if (bcc && bcc.length > 0) messageParts.push(`Bcc: ${bcc.join(', ')}`);
      messageParts.push(`Subject: ${subject}`);

      // For replies, set In-Reply-To and References headers
      let threadId: string | undefined;
      if (reply_to_message_id) {
        try {
          const originalMsg = await gmail.users.messages.get({
            userId: 'me',
            id: reply_to_message_id,
            format: 'metadata',
            metadataHeaders: ['Message-ID'],
          });
          const messageIdHeader = getHeader(originalMsg.data.payload?.headers ?? [], 'Message-ID');
          if (messageIdHeader) {
            messageParts.push(`In-Reply-To: ${messageIdHeader}`);
            messageParts.push(`References: ${messageIdHeader}`);
          }
          threadId = originalMsg.data.threadId ?? undefined;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('Could not fetch original message for reply', { error: message });
        }
      }

      messageParts.push('Content-Type: text/plain; charset=utf-8');
      messageParts.push('');
      messageParts.push(body);

      const rawMessage = messageParts.join('\r\n');
      const encodedMessage = encodeBase64Url(rawMessage);

      const sendResponse = await gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId,
        },
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            message_id: sendResponse.data.id ?? '',
            thread_id: sendResponse.data.threadId ?? '',
          }, null, 2),
        }],
      };
    },
  );
}
