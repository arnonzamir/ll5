import { readConfig, writeConfig } from '../utils/config.js';
import { writeToken } from '../utils/token.js';
import { prompt } from '../utils/prompt.js';

export async function loginCommand(): Promise<void> {
  let config = readConfig();

  if (!config) {
    console.log('No configuration found. Let\'s set up.');
    const gatewayUrl = await prompt('Gateway URL: ');
    const userId = await prompt('User ID: ');

    if (!gatewayUrl || !userId) {
      console.error('Gateway URL and User ID are required.');
      process.exit(1);
    }

    config = { gateway_url: gatewayUrl.replace(/\/+$/, ''), user_id: userId };
    writeConfig(config);
    console.log('Configuration saved to ~/.ll5/config');
  }

  console.log(`User: ${config.user_id}`);
  console.log(`Gateway: ${config.gateway_url}`);

  const pin = await prompt('PIN: ', true);
  if (!pin) {
    console.error('PIN is required.');
    process.exit(1);
  }

  console.log('Authenticating...');

  try {
    const res = await fetch(`${config.gateway_url}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: config.user_id, pin }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      const msg = body.error ?? `HTTP ${res.status}`;
      console.error(`Authentication failed: ${msg}`);
      process.exit(1);
    }

    const body = await res.json() as { token: string; expires_at: string };
    writeToken(body.token);
    console.log(`Authenticated. Token valid until ${body.expires_at}.`);
    console.log('Token saved to ~/.ll5/token');
  } catch (err) {
    console.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
