// Traefik labels that expose a per-user opencode console at
// `agent-<uid>.<base>` → the user's container :4096. Gated by CONSOLE_DOMAIN_BASE
// (empty = feature off, no labels emitted → no router created).
//
// SECURITY: the router carries a forwardAuth middleware pointing at the gateway's
// /internal/console-auth, so every console request is validated against the
// tenant's LL5 token (via a short-lived console cookie the gateway issues). The
// opencode server itself is only reachable through this authenticated route (and
// the trusted internal network); it is never exposed unauthenticated on the public
// internet.

/** Traefik router/middleware/service names must be a stable, unique, safe slug. */
function slug(userId: string): string {
  // uuids are already [0-9a-f-]; strip anything else defensively.
  return `console-${userId.replace(/[^a-zA-Z0-9-]/g, '')}`;
}

/** The public console host for a user, or null when the feature is disabled. */
export function consoleHost(userId: string, base: string | null | undefined): string | null {
  if (!base) return null;
  return `agent-${userId}.${base}`;
}

/**
 * Build the Traefik docker-label map for a user's console route. Returns `{}`
 * when disabled (no base) so the container gets no Traefik router.
 *
 * @param gatewayUrl in-network gateway base (e.g. http://gateway:3000) — the
 *   forwardAuth target.
 */
export function buildConsoleLabels(
  userId: string,
  base: string | null | undefined,
  gatewayUrl: string,
): Record<string, string> {
  const host = consoleHost(userId, base);
  if (!host) return {};
  const name = slug(userId);
  const mw = `${name}-auth`;
  return {
    'traefik.enable': 'true',
    [`traefik.http.routers.${name}.rule`]: `Host(\`${host}\`)`,
    [`traefik.http.routers.${name}.tls`]: 'true',
    [`traefik.http.routers.${name}.tls.certresolver`]: 'letsencrypt',
    [`traefik.http.routers.${name}.middlewares`]: mw,
    [`traefik.http.services.${name}.loadbalancer.server.port`]: '4096',
    // forwardAuth: Traefik calls the gateway for every request; the gateway
    // 200s only when the console cookie is valid AND its uid matches this host.
    // Set-Cookie is forwarded back so the enter-handshake can plant the cookie.
    [`traefik.http.middlewares.${mw}.forwardauth.address`]: `${gatewayUrl}/internal/console-auth`,
    [`traefik.http.middlewares.${mw}.forwardauth.trustForwardHeader`]: 'true',
    [`traefik.http.middlewares.${mw}.forwardauth.authResponseHeaders`]: 'Set-Cookie',
  };
}
