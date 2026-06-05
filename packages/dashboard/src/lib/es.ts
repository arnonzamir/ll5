import { env } from "./env";

/**
 * Elasticsearch is reached over plain HTTP on the internal network but now requires
 * basic auth (DECISION: ES security enabled). The dashboard talks to ES via raw
 * `fetch`, which (unlike the @elastic client) does NOT use credentials embedded in
 * the URL — so we strip them from the URL for the base and send them as an
 * Authorization header instead. ELASTICSEARCH_URL is `http://elastic:<pw>@host:9200`
 * in prod, plain `http://host:9200` in local dev (no auth header then).
 */
function parsed(): { base: string; auth?: string } {
  try {
    const u = new URL(env.ELASTICSEARCH_URL);
    const base = `${u.protocol}//${u.host}`;
    if (u.username) {
      const creds = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`;
      return { base, auth: `Basic ${Buffer.from(creds).toString("base64")}` };
    }
    return { base };
  } catch {
    return { base: env.ELASTICSEARCH_URL };
  }
}

/** ES base URL with inline credentials stripped. */
export function esBase(): string {
  return parsed().base;
}

/** Request headers for ES: JSON + Basic auth (when ELASTICSEARCH_URL carries creds). */
export function esHeaders(extra?: Record<string, string>): Record<string, string> {
  const { auth } = parsed();
  return {
    "Content-Type": "application/json",
    ...(auth ? { Authorization: auth } : {}),
    ...(extra ?? {}),
  };
}
