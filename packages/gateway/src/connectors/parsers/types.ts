/**
 * Parser input — what the phone (or the SMS mirror) handed the gateway for one
 * notification. Pure parsers turn this into a ConnectorEventInput
 * (docs/design/connectors.md, Section 2 "Shared code vs adapter").
 */
export interface ParserInput {
  connector_id: string;
  /** Android package for app_notification items; null for SMS. */
  package?: string | null;
  /** SMS sender id/name for message items; null for app notifications. */
  sender?: string | null;
  title: string | null;
  text: string | null;
  big_text: string | null;
  /** ISO-8601 with offset — the notification's post time (or SMS receive time). */
  post_time: string;
}

export type ParserName = 'cal' | 'max' | 'isracard' | 'sms-generic';
