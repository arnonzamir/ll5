/** Types for the admin invites UI (kept in a non-directive file per Next 15 rule). */

export interface Invite {
  id: string;
  email: string;
  role: string;
  invited_by: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
  pending: boolean;
}

export interface CreateInviteResult {
  success: boolean;
  invite?: Invite;
  accept_url?: string;
  error?: string;
}

export interface MutationResult {
  success: boolean;
  error?: string;
}
