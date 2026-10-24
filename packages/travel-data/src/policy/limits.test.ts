import { describe, expect, it } from 'vitest';
import { PolicyError } from './budget.ts';
import { createUsageControls, LIMIT_ENV, SAFE_DEFAULT_LIMITS, SKU, usageLimitsFromEnv } from './limits.ts';

describe('usageLimitsFromEnv', () => {
  it('uses the safe defaults when nothing is set', () => {
    expect(usageLimitsFromEnv({})).toEqual(SAFE_DEFAULT_LIMITS);
    expect(usageLimitsFromEnv({ [LIMIT_ENV.daily]: '', [LIMIT_ENV.perInput]: '  ' })).toEqual(SAFE_DEFAULT_LIMITS);
    // GCP quota is not a hard stop (Routes is unlimited there), so the code caps must stay within the assumed daily budget
    // (user, 2026-10-25): Places 100/day, Routes 200/day in total.
    const d = SAFE_DEFAULT_LIMITS.dailyPerSku;
    const sum = (prefix: string) => Object.entries(d).filter(([k]) => k.startsWith(prefix)).reduce((n, [, v]) => n + v, 0);
    expect(sum('places.')).toBeLessThanOrEqual(100);
    expect(sum('routes.')).toBeLessThanOrEqual(200);
    expect(d[SKU.routesDrive]).toBe(60);
  });

  it('lets the environment lower every limit', () => {
    const l = usageLimitsFromEnv({ [LIMIT_ENV.daily]: '5', [LIMIT_ENV.perInput]: '3', [LIMIT_ENV.concurrent]: '1' });
    expect(Object.values(l.dailyPerSku)).toEqual([5, 5, 5, 5, 5, 5]);
    expect(l).toMatchObject({ maxCallsPerInput: 3, maxConcurrent: 1 });
    // 0 switches provider calls off entirely.
    expect(Object.values(usageLimitsFromEnv({ [LIMIT_ENV.daily]: '0' }).dailyPerSku)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('refuses to raise a limit above its safe default, so the server does not start', () => {
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.daily]: '61' })).toThrow(/can only be lowered/);
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.perInput]: '9' })).toThrow(/can only be lowered/);
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.concurrent]: '3' })).toThrow(/can only be lowered/);
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.daily]: '99999999999999999999' })).toThrow(/can only be lowered/);
    // Leading zeros are read as decimal: 060 is the largest default itself, 061 is above it.
    expect(usageLimitsFromEnv({ [LIMIT_ENV.daily]: '060' }).dailyPerSku[SKU.routesDrive]).toBe(60);
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.daily]: '061' })).toThrow(/can only be lowered/);
    // A value between the defaults lowers only the SKUs above it: Places stays at 20, Routes drops to 30.
    const mid = usageLimitsFromEnv({ [LIMIT_ENV.daily]: '30' }).dailyPerSku;
    expect([mid[SKU.placesTextSearchPro], mid[SKU.routesDrive], mid[SKU.routesTransit]]).toEqual([20, 30, 30]);
  });

  it('refuses malformed values instead of guessing', () => {
    for (const bad of ['-1', '+5', '1.5', 'ten', '1e1', '0x5', '5 calls', '５', '٥']) {
      expect(() => usageLimitsFromEnv({ [LIMIT_ENV.daily]: bad }), bad).toThrow(/invalid/);
    }
    expect(() => usageLimitsFromEnv({ [LIMIT_ENV.concurrent]: '0' })).toThrow(/invalid/);
  });

  it('builds the shared quota and gate from the limits', async () => {
    const { quota, gate } = createUsageControls(usageLimitsFromEnv({ [LIMIT_ENV.daily]: '1' }), () => Date.parse('2026-10-24T09:00:00Z'));
    quota.take(SKU.routesTransit);
    expect(() => quota.take(SKU.routesTransit)).toThrow(PolicyError);
    expect(quota.remaining(SKU.placesTextSearchPro)).toBe(1);
    const release = await gate.acquire(new AbortController().signal);
    release();
  });
});
