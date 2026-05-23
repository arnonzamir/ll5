// Plain types + constants for the scheduler-settings page. Kept out of the
// `"use server"` file because Next.js 15 only allows async functions to be
// exported from server-action modules. Same pattern as data-sources-types.ts.

export interface SchedulerSettings {
  active_hours_start: number;
  active_hours_end: number;
  morning_briefing_hour: number;
  calendar_review_minutes: number;
  tickler_alert_minutes: number;
  tickler_lookahead_hours: number;
  heartbeat_silence_minutes: number;
  journal_nudge_minutes: number;
  gtd_health_hours: number;
  weekly_review_day: number;
  weekly_review_hour: number;
  message_batch_minutes: number;
  consolidation_hour: number;
  schedule_lookback_hours: number;
  schedule_lookahead_hours: number;
  // Narrative consolidation (daily rollup)
  narrative_consolidation_enabled: boolean;
  narrative_consolidation_hour: number;
  // Proactive agent-output trigger
  agent_output_minutes: number;
  agent_output_min_triggers: number;
  agent_output_silence_hours: number;
  agent_output_lookback_hours: number;
  // "Reply within N or narrate" watchdog — seconds granularity
  response_timeout_seconds: number;
}

export const DEFAULTS: SchedulerSettings = {
  active_hours_start: 7,
  active_hours_end: 22,
  morning_briefing_hour: 7,
  calendar_review_minutes: 120,
  tickler_alert_minutes: 60,
  tickler_lookahead_hours: 2,
  heartbeat_silence_minutes: 60,
  journal_nudge_minutes: 60,
  gtd_health_hours: 4,
  weekly_review_day: 0,
  weekly_review_hour: 14,
  message_batch_minutes: 30,
  consolidation_hour: 2,
  schedule_lookback_hours: 1,
  schedule_lookahead_hours: 3,
  narrative_consolidation_enabled: true,
  narrative_consolidation_hour: 3,
  agent_output_minutes: 15,
  agent_output_min_triggers: 2,
  agent_output_silence_hours: 0.5,
  agent_output_lookback_hours: 3,
  response_timeout_seconds: 120,
};
