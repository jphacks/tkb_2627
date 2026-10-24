import type { ErrorCode } from '@tkb/contracts';

/** A limit or cancellation hit by the policy layer. `code` maps to an ApiError (K23). */
export class PolicyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Error for a failed provider HTTP call, for adapters (D03/D04). 429 is never retryable (M1, Issue #11: a quota
 * error means the limit worked); 5xx and network failures are retryable within CallBudget's bounded attempts.
 */
export function providerError(status: number | null): PolicyError {
  if (status === 429) return new PolicyError('PROVIDER_RATE_LIMIT', 'provider rate limit or quota reached', false);
  if (status === null || status >= 500) return new PolicyError('PROVIDER_UNAVAILABLE', 'provider unavailable', true);
  return new PolicyError('PROVIDER_UNAVAILABLE', `provider rejected the request (${status})`, false);
}

export type Clock = () => number;

/**
 * Calls per SKU per day, shared by every input, set below the GCP project quota so we stop before Google does
 * (the GCP quota and budget alert are not a stop switch for our own usage, docs/08). A SKU without a limit gets 0.
 * The day boundary follows `timeZone` (default America/Los_Angeles, where Google Cloud per-day quotas reset).
 */
export class DailyQuota {
  private readonly counts = new Map<string, number>();
  private day = '';
  private readonly dayFormat: Intl.DateTimeFormat;

  constructor(
    private readonly limits: Readonly<Record<string, number>>,
    private readonly clock: Clock = Date.now,
    timeZone = 'America/Los_Angeles',
  ) {
    this.dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  }

  private roll(): void {
    const today = this.dayFormat.format(this.clock());
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
  }

  remaining(sku: string): number {
    this.roll();
    return Math.max(0, (this.limits[sku] ?? 0) - (this.counts.get(sku) ?? 0));
  }

  /** Reserves one call; throws PROVIDER_RATE_LIMIT (not retryable) when the day's limit is used up. */
  take(sku: string): void {
    if (this.remaining(sku) <= 0) throw new PolicyError('PROVIDER_RATE_LIMIT', `daily limit reached for ${sku}`, false);
    this.counts.set(sku, (this.counts.get(sku) ?? 0) + 1);
  }
}

const cancelled = () => new PolicyError('CANCELLED', 'cancelled', false);

/** Limits concurrent provider calls (docs/08: low concurrency). Waiting callers can be cancelled. */
export class Gate {
  private active = 0;
  private readonly waiting: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('Gate needs at least 1 slot');
  }

  /** Resolves with a release function once a slot is free. */
  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(cancelled());
    const release = () => {
      this.active -= 1;
      this.waiting.shift()?.resolve();
    };
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal.removeEventListener('abort', onAbort);
          this.active += 1;
          resolve(release);
        },
        reject,
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(cancelled());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
}

export interface CallBudgetOptions {
  /** Provider calls this input may make in total, retries included. */
  maxCalls: number;
  quota: DailyQuota;
  gate: Gate;
  /** Attempts per request including the first, 1-3 (default 2). Never unbounded. */
  maxAttempts?: number;
  /** Wait before retry number `n` (1-based); default 500 ms * n. */
  retryDelayMs?: (n: number) => number;
  /** Longest one attempt may take, in ms (default 15 s). A call that ignores its signal still frees its slot then. */
  callTimeoutMs?: number;
  /** Cancels the whole budget, e.g. when the HTTP request that started it is closed. */
  signal?: AbortSignal;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Provider calls allowed for one input (one search, one plan generation): a hard call count, the shared daily quota
 * and concurrency gate, bounded retries, a per-attempt timeout, cancellation, and one shared call for identical
 * requests in flight within this input (repeated presses while a search runs do not multiply calls).
 * It does not limit a user across separate requests: per-user limits belong to the server (T05); the shared
 * DailyQuota is the last guard before the GCP quota.
 */
export class CallBudget {
  private used = 0;
  private readonly controller = new AbortController();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxAttempts: number;
  private readonly retryDelayMs: (n: number) => number;
  private readonly callTimeoutMs: number;

  constructor(private readonly options: CallBudgetOptions) {
    if (!Number.isInteger(options.maxCalls) || options.maxCalls < 0) throw new RangeError('maxCalls must be a non-negative integer');
    this.maxAttempts = Math.min(3, Math.max(1, Math.floor(options.maxAttempts ?? 2)));
    this.retryDelayMs = options.retryDelayMs ?? (n => 500 * n);
    this.callTimeoutMs = options.callTimeoutMs ?? 15_000;
    if (options.signal?.aborted) this.controller.abort();
    else options.signal?.addEventListener('abort', () => this.cancel(), { once: true });
  }

  get callsUsed(): number {
    return this.used;
  }

  get remaining(): number {
    return this.options.maxCalls - this.used;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Aborts calls in flight and refuses new ones. */
  cancel(): void {
    this.controller.abort();
  }

  /**
   * Runs `call` for the request identified by `key`, charging `sku`. A request whose key is already in flight returns
   * the same promise without another call. Retries only PolicyErrors marked retryable (never 429 / quota).
   */
  run<T>(sku: string, key: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = `${sku}\u0000${key}`;
    const existing = this.inFlight.get(id);
    if (existing) return existing as Promise<T>;
    const promise = this.attempt(sku, call).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, promise);
    return promise;
  }

  /** Runs one attempt; settles on abort or timeout even if `call` ignores its signal. */
  private once<T>(call: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    const attempt = AbortSignal.any([signal, AbortSignal.timeout(this.callTimeoutMs)]);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () =>
        reject(signal.aborted ? cancelled() : new PolicyError('PROVIDER_UNAVAILABLE', 'provider call timed out', true));
      if (attempt.aborted) return onAbort();
      attempt.addEventListener('abort', onAbort, { once: true });
      call(attempt).then(resolve, reject).finally(() => attempt.removeEventListener('abort', onAbort));
    });
  }

  private async attempt<T>(sku: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = this.controller.signal;
    let lastError: unknown = null;
    const limitReached = () =>
      // During retries, report the failure that caused them rather than the limit.
      lastError ?? new PolicyError('PROVIDER_RATE_LIMIT', 'call limit for this input reached', false);
    for (let n = 1; ; n += 1) {
      if (signal.aborted) throw cancelled();
      if (this.used >= this.options.maxCalls) throw limitReached();
      // Charge only once a slot is held, so a call cancelled while waiting costs nothing.
      const release = await this.options.gate.acquire(signal);
      try {
        if (signal.aborted) throw cancelled();
        if (this.used >= this.options.maxCalls) throw limitReached();
        this.options.quota.take(sku);
        this.used += 1;
        return await this.once(call, signal);
      } catch (e) {
        if (signal.aborted) throw cancelled();
        const retry = e instanceof PolicyError && e.retryable && e.code !== 'PROVIDER_RATE_LIMIT' && n < this.maxAttempts;
        if (!retry) throw e;
        lastError = e;
      } finally {
        release();
      }
      await sleep(this.retryDelayMs(n), signal);
    }
  }
}
