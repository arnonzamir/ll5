import { deleteToken } from '../utils/token.js';

export function logoutCommand(): void {
  deleteToken();
  console.log('Logged out.');
}
