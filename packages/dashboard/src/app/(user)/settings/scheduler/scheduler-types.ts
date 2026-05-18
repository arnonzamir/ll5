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
};
