/** In-memory failed-attempt limiter (single shared server process). */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly maxKeys = 10_000,
  ) {}

  private recent(key: string, now: number): number[] {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Milliseconds until another attempt is allowed; 0 when allowed. */
  retryAfterMs(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    return list.length >= this.max ? this.windowMs - (now - list[0]!) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const list = this.recent(key, now);
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest !== undefined) this.hits.delete(oldest);
    }
  }

  /** Cancels the most recent counted failure (used when a pre-counted attempt turns out to succeed). */
  undo(key: string): void {
    const list = this.hits.get(key);
    if (!list) return;
    list.pop();
    if (!list.length) this.hits.delete(key);
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}
