import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** Constant-time string equality (hashes first so lengths never leak). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

export type PairingResult = 'ok' | 'invalid' | 'locked' | 'expired';

export interface PairingOptions {
  ttlMs: number;
  maxAttempts?: number;
  now?: () => number;
}

/**
 * Short-lived, single-use pairing code. Only the process (main.ts / tests) can call issue();
 * the code is never exposed over HTTP. Wrong guesses are counted and invalidate the code.
 */
export class PairingStore {
  private hash: Buffer | null = null;
  private expiresAt = 0;
  private attempts = 0;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  constructor(private readonly opts: PairingOptions) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.now = opts.now ?? Date.now;
  }

  issue(): string {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, b => ALPHABET[b % ALPHABET.length]).join('');
    this.hash = digest(code);
    this.expiresAt = this.now() + this.opts.ttlMs;
    this.attempts = 0;
    return code;
  }

  verify(code: string): PairingResult {
    // No active code (never issued, used, expired or locked out earlier): expired.
    if (!this.hash || this.now() > this.expiresAt) {
      this.hash = null;
      return 'expired';
    }
    if (timingSafeEqual(digest(code), this.hash)) {
      this.hash = null; // single use
      return 'ok';
    }
    if (++this.attempts >= this.maxAttempts) {
      this.hash = null;
      return 'locked';
    }
    return 'invalid';
  }
}
