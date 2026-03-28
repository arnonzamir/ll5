#!/usr/bin/env node

import { loginCommand } from './commands/login.js';
import { statusCommand } from './commands/status.js';
import { logoutCommand } from './commands/logout.js';
import { setupCommand } from './commands/setup.js';

const command = process.argv[2];

const USAGE = `Usage: ll5-auth <command>

Commands:
  login    Authenticate and save token
  status   Show token status and expiry
  logout   Delete saved token
  setup    Configure gateway URL and user ID`;

async function main(): Promise<void> {
  switch (command) {
    case 'login':
      await loginCommand();
      break;
    case 'status':
      statusCommand();
      break;
    case 'logout':
      logoutCommand();
      break;
    case 'setup':
      await setupCommand();
      break;
    default:
      console.log(USAGE);
      process.exit(command ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
