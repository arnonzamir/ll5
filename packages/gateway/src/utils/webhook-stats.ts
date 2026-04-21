// Silent-failure counter for webhook ancillary paths (phone-contact
// enrichment, calendar cleanup, etc). Each is non-fatal for the webhook
// response but still represents real data rotting if it persists. Before
// this, these failures were logger.warn with no counter — invisible.

export interface WebhookFailureStats {
  total_failures: number;
  last_failure_at: string | null;
  last_error: string | null;
  by_step: Record<string, number>;
}

const stats: WebhookFailureStats = {
  total_failures: 0,
  last_failure_at: null,
  last_error: null,
  by_step: {},
};

export function recordWebhookFailure(step: string, err: unknown): void {
  stats.total_failures += 1;
  stats.last_failure_at = new Date().toISOString();
  stats.last_error = err instanceof Error ? err.message : String(err);
  stats.by_step[step] = (stats.by_step[step] ?? 0) + 1;
}

export function getWebhookStats(): WebhookFailureStats {
  return { ...stats, by_step: { ...stats.by_step } };
}
