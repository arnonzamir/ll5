// Types + pure helpers for the unified onboarding wizard.
// No "use server" directive — this module exports non-async values (types,
// constants, pure functions) shared by the client view, the server actions,
// and the unit tests. (Next 15 only allows async exports from "use server"
// modules, so anything synchronous must live here.)

/** Step keys persisted under user_settings.onboarding.steps.<key>. */
export type StepKey =
  | "profile_set"
  | "notifications_set"
  | "google_connected"
  | "whatsapp_connected"
  | "health_connected"
  | "phone_linked"
  | "agent_connected";

/** The onboarding.steps map: step key → done. Partial because the backend
 *  only writes keys that have been touched. */
export type OnboardingStepMap = Partial<Record<StepKey, boolean>>;

export interface OnboardingState {
  completed: boolean;
  steps: OnboardingStepMap;
}

/** Channel-connection flags as derived live by GET /me/onboarding. */
export interface OnboardingChannels {
  google: boolean;
  whatsapp: boolean;
  health: boolean;
}

export interface OnboardingPhone {
  linked: boolean;
  device_count: number;
}

export interface OnboardingProfile {
  display_name: string | null;
  timezone: string | null;
  work_week: unknown | null;
  self_names: unknown | null;
}

/** Full shape returned by GET /me/onboarding (self-scoped). */
export interface MeOnboarding {
  onboarding: OnboardingState;
  channels: OnboardingChannels;
  phone: OnboardingPhone;
  profile: OnboardingProfile;
}

/** A visible wizard panel. Some panels own more than one step key (Channels
 *  bundles whatsapp + health), so `keys` is a list. `required` panels have no
 *  Skip; everything else is optional/skippable. */
export interface WizardStep {
  id: WizardStepId;
  label: string;
  keys: StepKey[];
  required: boolean;
}

export type WizardStepId =
  | "profile"
  | "notifications"
  | "google"
  | "channels"
  | "phone"
  | "agent"
  | "done";

/**
 * The ordered wizard. `done` is the terminal panel and carries no step key
 * (completion is the separate `onboarding.completed` flag).
 */
export const WIZARD_STEPS: WizardStep[] = [
  { id: "profile", label: "Profile", keys: ["profile_set"], required: true },
  { id: "notifications", label: "Notifications", keys: ["notifications_set"], required: true },
  { id: "google", label: "Google", keys: ["google_connected"], required: false },
  { id: "channels", label: "Channels", keys: ["whatsapp_connected", "health_connected"], required: false },
  { id: "phone", label: "Phone", keys: ["phone_linked"], required: false },
  { id: "agent", label: "Your agent", keys: ["agent_connected"], required: false },
  { id: "done", label: "Done", keys: [], required: false },
];

/** Every step key the wizard tracks, in panel order. Drives progress. */
export const ALL_STEP_KEYS: StepKey[] = WIZARD_STEPS.flatMap((s) => s.keys);

/**
 * A wizard panel is "complete" when all of its step keys are done. The terminal
 * `done` panel is complete only once `onboarding.completed` is true.
 */
export function isStepComplete(
  step: WizardStep,
  steps: OnboardingStepMap,
  completed: boolean,
): boolean {
  if (step.id === "done") return completed;
  if (step.keys.length === 0) return true;
  return step.keys.every((k) => steps[k] === true);
}

/**
 * Index (into WIZARD_STEPS) of the first panel whose step keys are not all
 * done. If every tracked key is done, returns the index of the `done` panel.
 * Used to resume the wizard where the user left off.
 */
export function firstIncompleteStepIndex(steps: OnboardingStepMap): number {
  for (let i = 0; i < WIZARD_STEPS.length; i++) {
    const step = WIZARD_STEPS[i];
    if (step.id === "done") return i;
    if (step.keys.length === 0) continue;
    if (!step.keys.every((k) => steps[k] === true)) return i;
  }
  return WIZARD_STEPS.length - 1;
}

export interface StepProgress {
  /** Number of tracked step keys marked done. */
  done: number;
  /** Total tracked step keys. */
  total: number;
  /** Integer 0–100; 100 when onboarding.completed is true. */
  percent: number;
}

/**
 * Overall progress across all tracked step keys. `completed=true` forces 100%
 * regardless of individual keys (mirrors the admin-console onboardingProgress).
 */
export function stepProgress(
  steps: OnboardingStepMap,
  completed: boolean,
): StepProgress {
  const total = ALL_STEP_KEYS.length;
  const done = ALL_STEP_KEYS.filter((k) => steps[k] === true).length;
  if (completed) return { done: total, total, percent: 100 };
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, percent };
}
