/**
 * One K01 Idempotency-Key per submission. A retry of the same submission (same request body) reuses the key, so the
 * server returns the same job instead of creating a second one; a different body, or a submission after the previous
 * one was accepted, gets a new key. Keys are 8 to 128 characters of A-Z a-z 0-9 _ - (K01).
 */
export function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `u01-${uuid}`;
  // Not cryptographic; only needs to be unique per submission in this browser tab.
  return `u01-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface SubmissionKeys {
  /** The key for this request body: the pending one when the body is identical, otherwise a new one. */
  keyFor: (request: unknown) => string;
  /** The submission was accepted: the next submission starts with a new key. */
  release: () => void;
}

export function createSubmissionKeys(make: () => string = newIdempotencyKey): SubmissionKeys {
  let pending: { fingerprint: string; key: string } | null = null;
  return {
    keyFor(request) {
      const fingerprint = JSON.stringify(request);
      if (!pending || pending.fingerprint !== fingerprint) pending = { fingerprint, key: make() };
      return pending.key;
    },
    release() {
      pending = null;
    },
  };
}
