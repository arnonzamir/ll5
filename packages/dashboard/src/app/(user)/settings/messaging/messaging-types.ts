// Plain types for the messaging settings page. Kept out of the "use server"
// file because Next.js 15 only allows async functions to be exported from
// server-action modules.

export interface Account {
  account_id: string;
  platform: string;
  display_name: string;
  status: string;
  last_seen_at?: string;
}

export interface Conversation {
  id: string;
  account_id: string;
  platform: string;
  conversation_id: string;
  name: string | null;
  is_group: boolean;
  is_archived: boolean;
  permission: "agent" | "input" | "ignore";
  last_message_at: string | null;
}

export interface PairingQr {
  base64: string | null;
  pairing_code: string | null;
}

export interface ProvisionResult {
  success: boolean;
  account?: {
    id: string;
    instance_name: string;
    instance_id: string;
    api_url: string;
    status: string;
  };
  qr?: PairingQr;
  error?: string;
  message?: string;
}

export interface AccountStatus {
  account_id: string;
  platform: string;
  display_name: string;
  status: string;
  last_seen_at: string | null;
  last_error: string | null;
  uptime_seconds: number | null;
  message_count_today: number;
}
