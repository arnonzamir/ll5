/**
 * Typed adapter failures. The sync step maps them onto the connector row and
 * the SyncResult: AdapterAuthError → status 'auth_failed' (+ one auth_failed
 * finding); AdapterPlanError → status 'error' with code 'plan_not_eligible';
 * anything else → status 'error'. Messages never carry credential values.
 */

/** The source rejected the stored credentials (after any re-mint the adapter allows itself). */
export class AdapterAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterAuthError';
  }
}

/** The source answered "not on your plan" — credentials are fine, the endpoint is not. */
export class AdapterPlanError extends Error {
  readonly code = 'plan_not_eligible' as const;
  constructor(message: string) {
    super(message);
    this.name = 'AdapterPlanError';
  }
}
