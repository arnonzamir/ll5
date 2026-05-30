/** Minimum password length for human accounts (P1 identity). */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate a new password + its confirmation. Pure (no I/O) so it can be unit
 * tested and shared between server actions and any client-side pre-check.
 * Returns null when valid, or a human-readable error message.
 */
export function validateNewPassword(
  password: string,
  confirm: string
): string | null {
  if (!password || !confirm) return "Please enter and confirm a password.";
  if (password !== confirm) return "Passwords do not match.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}
