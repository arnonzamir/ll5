/**
 * Time formatting for agent-facing data.
 *
 * The agent gets confused when timestamps arrive in mixed shapes — sometimes
 * UTC ISO, sometimes localized strings with no TZ name, sometimes neither.
 * Every timestamp shown to the agent should be a paired {utc, local, tz}
 * triple so it never has to convert mentally.
 */

/**
 * Resolve the session timezone — the canonical TZ for this process.
 * Reads `process.env.TZ` first (set by deployment / ll5-run launcher),
 * falls back to the host's resolved IANA zone, then 'UTC'.
 */
export function sessionTimezone(): string {
  const envTz = process.env.TZ;
  if (envTz) return envTz;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export interface FormattedTime {
  /** ISO 8601 UTC, second precision (no milliseconds): "2026-04-30T11:30:00Z" */
  utc: string;
  /** Local rendering with weekday: "2026-04-30 14:30 Tuesday" */
  local: string;
  /** IANA TZ name: "Asia/Jerusalem" */
  tz: string;
}

const dateFmtCache = new Map<string, Intl.DateTimeFormat>();
const timeFmtCache = new Map<string, Intl.DateTimeFormat>();
const weekdayFmtCache = new Map<string, Intl.DateTimeFormat>();

function cached(map: Map<string, Intl.DateTimeFormat>, tz: string, build: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let fmt = map.get(tz);
  if (!fmt) {
    fmt = build();
    map.set(tz, fmt);
  }
  return fmt;
}

export function formatTime(input: Date | string | number, tz: string): FormattedTime {
  const d = input instanceof Date ? input : new Date(input);
  const utc = d.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const datePart = cached(dateFmtCache, tz, () => new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  })).format(d);

  const timePart = cached(timeFmtCache, tz, () => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  })).format(d);

  const weekday = cached(weekdayFmtCache, tz, () => new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'long',
  })).format(d);

  return { utc, local: `${datePart} ${timePart} ${weekday}`, tz };
}

/**
 * Single-line banner suitable for `[Time Check]` and similar system messages.
 * Example: `2026-04-30 Tuesday 14:30 Asia/Jerusalem (UTC: 2026-04-30T11:30:00Z)`
 */
export function timeBanner(input: Date | string | number, tz: string): string {
  const d = input instanceof Date ? input : new Date(input);
  const t = formatTime(d, tz);
  // Reorder local for readability in banner form.
  const [datePart, timePart, weekday] = t.local.split(' ');
  return `${datePart} ${weekday} ${timePart} ${tz} (UTC: ${t.utc})`;
}
