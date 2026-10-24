import { describe, expect, it, vi } from 'vitest';
import { CallBudget, DailyQuota, Gate, PolicyError, providerError } from './budget.ts';

const budget = (over: Partial<ConstructorParameters<typeof CallBudget>[0]> = {}) =>
  new CallBudget({ maxCalls: 5, quota: new DailyQuota({ search: 100 }), gate: new Gate(2), retryDelayMs: () => 0, ...over });

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof PolicyError ? e.code : String(e);
  }
};

describe('CallBudget', () => {
  it('shares one call between identical requests pressed repeatedly (連打)', async () => {
    const b = budget();
    const call = vi.fn(async () => 'result');
    const results = await Promise.all(Array.from({ length: 10 }, () => b.run('search', 'q:兼六園', call)));
    expect(results).toEqual(Array(10).fill('result'));
    expect(call).toHaveBeenCalledTimes(1);
    expect(b.callsUsed).toBe(1);
    // Once finished, the same request is a new call (no hidden cache).
    await b.run('search', 'q:兼六園', call);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('never exceeds the per-input limit when many different requests start at once', async () => {
    const b = budget({ maxCalls: 2, gate: new Gate(5) });
    const call = vi.fn(async () => {
      await new Promise(r => setTimeout(r, 5));
      return 'ok';
    });
    const codes = await Promise.all(Array.from({ length: 10 }, (_, i) => codeOf(b.run('search', `k${i}`, call))));
    expect(call).toHaveBeenCalledTimes(2);
    expect(codes.filter(c => c === 'resolved')).toHaveLength(2);
    expect(codes.filter(c => c === 'PROVIDER_RATE_LIMIT')).toHaveLength(8);
  });

  it('does not share a result between different SKUs with the same key', async () => {
    const b = budget({ quota: new DailyQuota({ search: 10, details: 10 }) });
    const [a, c] = await Promise.all([b.run('search', 'k', async () => 'A'), b.run('details', 'k', async () => 'B')]);
    expect([a, c]).toEqual(['A', 'B']);
  });

  it('frees the slot when a call ignores its signal and times out', async () => {
    const gate = new Gate(1);
    const b = budget({ gate, callTimeoutMs: 20, maxAttempts: 1 });
    expect(await codeOf(b.run('search', 'hang', () => new Promise(() => {})))).toBe('PROVIDER_UNAVAILABLE');
    expect(await budget({ gate }).run('search', 'next', async () => 'ok')).toBe('ok');
  });

  it('settles at once on cancel even if the call ignores its signal', async () => {
    const b = budget();
    const running = b.run('search', 'deaf', () => new Promise(() => {}));
    await Promise.resolve();
    b.cancel();
    expect(await codeOf(running)).toBe('CANCELLED');
  });

  it('reports the failure behind the retries when the input limit is reached during them', async () => {
    const b = budget({ maxCalls: 2, maxAttempts: 3 });
    expect(await codeOf(b.run('search', 'x', async () => { throw providerError(503); }))).toBe('PROVIDER_UNAVAILABLE');
    expect(b.callsUsed).toBe(2);
  });

  it('stops at the per-input call limit, counting retries', async () => {
    const b = budget({ maxCalls: 3 });
    const ok = async () => 'ok';
    let n = 0;
    const flakyOnce = async () => {
      n += 1;
      if (n === 1) throw providerError(503);
      return 'ok';
    };
    await b.run('search', 'a', flakyOnce); // 2 calls: one failure and its retry
    await b.run('search', 'b', ok);
    expect(await codeOf(b.run('search', 'c', ok))).toBe('PROVIDER_RATE_LIMIT');
    expect(b.remaining).toBe(0);
  });

  it('never retries endlessly: bounded attempts on 5xx, none on 429 (無限再試行)', async () => {
    const failing = vi.fn(async () => {
      throw providerError(503);
    });
    expect(await codeOf(budget({ maxAttempts: 99 }).run('search', 'x', failing))).toBe('PROVIDER_UNAVAILABLE');
    expect(failing).toHaveBeenCalledTimes(3); // capped at 3 even when 99 is asked for

    const limited = vi.fn(async () => {
      throw providerError(429);
    });
    expect(await codeOf(budget().run('search', 'y', limited))).toBe('PROVIDER_RATE_LIMIT');
    expect(limited).toHaveBeenCalledTimes(1);

    const badRequest = vi.fn(async () => {
      throw providerError(400);
    });
    await codeOf(budget().run('search', 'z', badRequest));
    expect(badRequest).toHaveBeenCalledTimes(1);

    const other = vi.fn(async () => {
      throw new TypeError('boom');
    });
    expect(await codeOf(budget().run('search', 'w', other))).toContain('boom');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('retries a transient failure once and succeeds, charging both attempts', async () => {
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n === 1) throw providerError(null);
      return 'ok';
    };
    const b = budget();
    expect(await b.run('search', 'k', flaky)).toBe('ok');
    expect(b.callsUsed).toBe(2);
  });

  it('cancels calls in flight and refuses new ones', async () => {
    const b = budget();
    const seen: AbortSignal[] = [];
    const slow = (signal: AbortSignal) =>
      new Promise<string>((_, reject) => {
        seen.push(signal);
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const running = b.run('search', 'slow', slow);
    await Promise.resolve();
    b.cancel();
    expect(await codeOf(running)).toBe('CANCELLED');
    expect(seen[0]!.aborted).toBe(true);
    expect(await codeOf(b.run('search', 'next', async () => 'x'))).toBe('CANCELLED');
  });

  it('follows the parent signal (the HTTP request was closed) and cancels a pending retry wait', async () => {
    const parent = new AbortController();
    const b = budget({ signal: parent.signal, retryDelayMs: () => 60_000 });
    const running = b.run('search', 'r', async () => {
      throw providerError(503);
    });
    await new Promise(r => setTimeout(r, 0));
    parent.abort();
    expect(await codeOf(running)).toBe('CANCELLED');
  });

  it('does not charge a call cancelled while waiting for a slot', async () => {
    const quota = new DailyQuota({ search: 10 });
    const gate = new Gate(1);
    const holder = budget({ quota, gate });
    let finish!: () => void;
    const held = holder.run('search', 'hold', () => new Promise<void>(r => (finish = r)));
    const waiter = budget({ quota, gate });
    const waiting = waiter.run('search', 'wait', async () => 'x');
    waiter.cancel();
    expect(await codeOf(waiting)).toBe('CANCELLED');
    expect(waiter.callsUsed).toBe(0);
    expect(quota.remaining('search')).toBe(9);
    finish();
    await held;
  });
});

describe('DailyQuota and Gate', () => {
  it('denies a SKU without a limit, resets at the Pacific day boundary', () => {
    let now = Date.parse('2026-10-24T06:59:00Z'); // 23:59 PDT on 10-23
    const q = new DailyQuota({ search: 2 }, () => now);
    expect(() => q.take('photos')).toThrow(PolicyError);
    q.take('search');
    q.take('search');
    expect(() => q.take('search')).toThrow(/daily limit/);
    now = Date.parse('2026-10-24T07:01:00Z'); // 00:01 PDT on 10-24
    expect(q.remaining('search')).toBe(2);
  });

  it('keeps concurrency at the limit', async () => {
    const gate = new Gate(2);
    const b = budget({ gate, maxCalls: 10 });
    let active = 0;
    let peak = 0;
    const work = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active -= 1;
    };
    await Promise.all(['a', 'b', 'c', 'd', 'e'].map(k => b.run('search', k, work)));
    expect(peak).toBe(2);
    expect(() => new Gate(0)).toThrow(RangeError);
  });
});
