import { writeConfig } from '../utils/config.js';
import { prompt } from '../utils/prompt.js';

export async function setupCommand(): Promise<void> {
  const gatewayUrl = await prompt('Gateway URL: ');
  const userId = await prompt('User ID: ');

  if (!gatewayUrl || !userId) {
    console.error('Gateway URL and User ID are required.');
    process.exit(1);
  }

  writeConfig({
    gateway_url: gatewayUrl.replace(/\/+$/, ''),
    user_id: userId,
  });

  console.log('Configuration saved to ~/.ll5/config');
}
