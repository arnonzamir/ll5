import { readToken, decodeTokenPayload } from '../utils/token.js';

export function statusCommand(): void {
  const token = readToken();
  if (!token) {
    console.log('No token found. Run: ll5-auth login');
    process.exit(1);
  }

  const payload = decodeTokenPayload(token);
  if (!payload) {
    console.log('Token is malformed. Run: ll5-auth login');
    process.exit(1);
  }

  const expiresAt = new Date(payload.exp * 1000);
  const now = Date.now();
  const daysRemaining = Math.max(0, Math.ceil((payload.exp * 1000 - now) / 86400000));
  const isExpired = now > payload.exp * 1000;

  console.log(`User: ${payload.uid}`);
  console.log(`Expires: ${expiresAt.toISOString()} (${daysRemaining} days remaining)`);
  console.log(`Status: ${isExpired ? 'expired' : 'valid'}`);

  if (isExpired) {
    process.exit(1);
  }
}
