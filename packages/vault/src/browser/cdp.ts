/**
 * CDP connection helper for the shared browser container (DECISION-022 §3).
 *
 * BROWSER_CDP_URL is an internal-Docker HTTP endpoint (http://browser:9222 —
 * never published, never behind Traefik). Two subtleties:
 *
 *  1. Chromium's DevTools HTTP server rejects Host headers that aren't an IP
 *     or "localhost" (rebind protection), and a Docker service name is
 *     neither — so we fetch /json/version ourselves via node:http with a
 *     forced `Host: 127.0.0.1` header.
 *  2. The returned webSocketDebuggerUrl points at 127.0.0.1; we rewrite its
 *     host:port back to the Docker endpoint before connecting.
 *
 * connectOverCDP() attaches to the SAME live browser + profile the agent's
 * Playwright MCP drives, so a successful login is immediately usable by the
 * agent's own browsing tools. browser.close() on a CDP connection only
 * disconnects — it never kills the shared browser.
 */
import http from 'node:http';
import { chromium, type Browser } from 'playwright-core';

export async function resolveCdpWebSocketUrl(cdpHttpUrl: string): Promise<string> {
  const target = new URL(cdpHttpUrl);
  const versionJson = await new Promise<string>((resolve, reject) => {
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: '/json/version',
        method: 'GET',
        // Chromium requires an IP/localhost Host header.
        headers: { Host: '127.0.0.1' },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`CDP /json/version -> HTTP ${res.statusCode}`));
          } else {
            resolve(Buffer.concat(chunks).toString('utf8'));
          }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('CDP /json/version timeout')); });
    req.on('error', reject);
    req.end();
  });

  const parsed = JSON.parse(versionJson) as { webSocketDebuggerUrl?: string };
  if (!parsed.webSocketDebuggerUrl) {
    throw new Error('CDP /json/version returned no webSocketDebuggerUrl');
  }
  const ws = new URL(parsed.webSocketDebuggerUrl);
  ws.hostname = target.hostname;
  ws.port = target.port || '9222';
  return ws.toString();
}

export async function connectSharedBrowser(cdpHttpUrl: string): Promise<Browser> {
  const wsUrl = await resolveCdpWebSocketUrl(cdpHttpUrl);
  return chromium.connectOverCDP(wsUrl, { timeout: 15_000 });
}
