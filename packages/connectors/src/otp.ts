/**
 * In-memory OTP hand-off between `submit_otp` and a pull that is waiting for a
 * code. Codes live 60 s; nothing is persisted. Keyed by user + connector.
 */

export interface OtpSubmitResult {
  accepted: boolean;
  /** A pull was blocked on this code and has now received it. */
  waiting_pull: boolean;
}

interface Stored {
  code: string;
  expiresAt: number;
}

interface Waiter {
  resolve: (code: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

export const OTP_TTL_MS = 60_000;
const CODE_RE = /^\d{4,8}$/;

export class OtpStore {
  private readonly codes = new Map<string, Stored>();
  private readonly waiters = new Map<string, Waiter>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  private key(userId: string, connectorId: string): string {
    return `${userId}:${connectorId}`;
  }

  /** Store a code (or hand it straight to a waiting pull). Malformed codes are refused. */
  submit(userId: string, connectorId: string, code: string): OtpSubmitResult {
    const trimmed = code.trim();
    if (!CODE_RE.test(trimmed)) return { accepted: false, waiting_pull: false };
    const k = this.key(userId, connectorId);
    const waiter = this.waiters.get(k);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.waiters.delete(k);
      waiter.resolve(trimmed);
      return { accepted: true, waiting_pull: true };
    }
    this.codes.set(k, { code: trimmed, expiresAt: this.now() + OTP_TTL_MS });
    return { accepted: true, waiting_pull: false };
  }

  /** Take a live code (single use), or null when none / expired. */
  take(userId: string, connectorId: string): string | null {
    const k = this.key(userId, connectorId);
    const s = this.codes.get(k);
    if (!s) return null;
    this.codes.delete(k);
    return s.expiresAt > this.now() ? s.code : null;
  }

  /** Resolve with a code already stored, or wait up to `timeoutMs` for one to be submitted. */
  waitFor(userId: string, connectorId: string, timeoutMs = OTP_TTL_MS): Promise<string | null> {
    const existing = this.take(userId, connectorId);
    if (existing) return Promise.resolve(existing);
    const k = this.key(userId, connectorId);
    const prev = this.waiters.get(k);
    if (prev) {
      clearTimeout(prev.timer);
      prev.resolve(null);
    }
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(k);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(k, { resolve, timer });
    });
  }

  /** True while a pull is blocked on a code for this connector. */
  isWaiting(userId: string, connectorId: string): boolean {
    return this.waiters.has(this.key(userId, connectorId));
  }
}
