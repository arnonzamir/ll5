import { describe, it, expect } from 'vitest';
import { buildConsoleLabels, consoleHost } from '../console-labels.js';

const UID = 'f08f46b3-0a9c-41ae-9e6a-294c697424e4';

describe('console-labels', () => {
  it('emits no labels when the base is empty (feature off)', () => {
    expect(buildConsoleLabels(UID, undefined, 'http://gateway:3000')).toEqual({});
    expect(buildConsoleLabels(UID, '', 'http://gateway:3000')).toEqual({});
    expect(consoleHost(UID, undefined)).toBeNull();
  });

  it('builds a Host router + forwardAuth middleware for the per-user subdomain', () => {
    const labels = buildConsoleLabels(UID, 'noninoni.click', 'http://gateway:3000');
    expect(consoleHost(UID, 'noninoni.click')).toBe(`agent-${UID}.noninoni.click`);
    expect(labels['traefik.enable']).toBe('true');
    expect(labels[`traefik.http.routers.console-${UID}.rule`]).toBe(
      `Host(\`agent-${UID}.noninoni.click\`)`,
    );
    expect(labels[`traefik.http.routers.console-${UID}.tls.certresolver`]).toBe('letsencrypt');
    expect(labels[`traefik.http.services.console-${UID}.loadbalancer.server.port`]).toBe('4096');
    // forwardAuth points at the gateway and is attached to the router.
    expect(labels[`traefik.http.routers.console-${UID}.middlewares`]).toBe(`console-${UID}-auth`);
    expect(labels[`traefik.http.middlewares.console-${UID}-auth.forwardauth.address`]).toBe(
      'http://gateway:3000/internal/console-auth',
    );
  });
});
