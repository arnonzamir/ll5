// Types + pure helpers for the superadmin Tenants console.
// No "use server" directive here — this file may export non-async values
// (types, constants, pure functions) consumed by both server actions and the
// client view.

import type { BadgeProps } from "@/components/ui/badge";
import {
  runtimeStatusBadge,
  normalizeRuntimeStatus,
  type AgentRuntimeStatus,
} from "@/app/(user)/settings/agent/agent-types";

// Re-export the shared runtime helpers so the tenant console imports them from a
// single place (the settings page owns the canonical agent runtime helpers).
export { runtimeStatusBadge, normalizeRuntimeStatus };
export type { AgentRuntimeStatus };

export interface TenantOnboarding {
  completed: boolean;
  steps: Record<string, boolean>;
}

export interface TenantChannels {
  google: boolean;
  whatsapp: boolean;
  health: boolean;
}

/** Per-tenant hosted-agent runtime summary (trimmed from `agent_runtimes`). */
export interface TenantAgentRuntime {
  status: AgentRuntimeStatus;
  last_seen_at: string | null;
}

export interface Tenant {
  user_id: string;
  email: string | null;
  username: string | null;
  display_name: string | null;
  role: string;
  enabled: boolean;
  created_at: string | null;
  onboarding: TenantOnboarding;
  channels: TenantChannels;
  last_active_at: string | null;
  /** Hosted-agent runtime status; absent on older gateway responses. */
  agent_runtime?: TenantAgentRuntime;
}

export interface MutationResult {
  success: boolean;
  error?: string;
}

export interface InviteResult {
  success: boolean;
  accept_url?: string;
  error?: string;
}

// --- Pure helpers (unit-tested) ---

type BadgeVariant = NonNullable<BadgeProps["variant"]>;

/**
 * Badge variant for a role. Includes 'superadmin', styled distinctly
 * (destructive = the loudest variant) from 'admin' (default) and 'user'.
 */
export function roleBadgeVariant(role: string): BadgeVariant {
  switch (role) {
    case "superadmin":
      return "destructive";
    case "admin":
      return "default";
    default:
      return "secondary";
  }
}

export interface OnboardingProgress {
  complete: boolean;
  /** Integer 0–100. 100 when complete or when there are no steps. */
  percent: number;
  done: number;
  total: number;
}

/**
 * Compute onboarding progress from `onboarding.steps` (a map of step→done).
 * If `completed` is already true, reports 100% complete. With no steps and not
 * completed, reports 0%.
 */
export function onboardingProgress(
  onboarding: TenantOnboarding | null | undefined
): OnboardingProgress {
  const completed = !!onboarding?.completed;
  const steps = onboarding?.steps ?? {};
  const keys = Object.keys(steps);
  const total = keys.length;
  const done = keys.filter((k) => steps[k] === true).length;

  if (completed) {
    return { complete: true, percent: 100, done: total || done, total };
  }
  if (total === 0) {
    return { complete: false, percent: 0, done: 0, total: 0 };
  }
  const percent = Math.round((done / total) * 100);
  return { complete: percent === 100, percent, done, total };
}

/**
 * Relative time string for a past timestamp, or "never" when null/empty.
 * `now` is injectable for deterministic tests.
 */
export function relativeTime(
  dateStr: string | null | undefined,
  now: number = Date.now()
): string {
  if (!dateStr) return "never";
  const then = new Date(dateStr).getTime();
  if (Number.isNaN(then)) return "never";

  const diffSec = Math.round((now - then) / 1000);
  if (diffSec < 0) return "just now";
  if (diffSec < 45) return "just now";

  const minutes = Math.round(diffSec / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.round(months / 12);
  return `${years}y ago`;
}
