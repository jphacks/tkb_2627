import { DailyQuota, Gate, type Clock } from './budget.ts';

/**
 * SKUs the D03/D04 adapters charge (docs/provider-probe.md). For Places the tier follows the field mask; Routes is
 * keyed by travel mode because the TRANSIT tier is not confirmed yet.
 */
export const SKU = {
  placesTextSearchPro: 'places.text_search.pro',
  placesTextSearchEnterprise: 'places.text_search.enterprise',
  routesDrive: 'routes.compute_routes.drive',
  routesTransit: 'routes.compute_routes.transit',
} as const;
export type Sku = (typeof SKU)[keyof typeof SKU];

export interface UsageLimits {
  /** Calls per SKU per day, shared by all inputs. */
  dailyPerSku: Readonly<Record<Sku, number>>;
  /** Calls one input (one search, one plan generation) may make, retries included. */
  maxCallsPerInput: number;
  /** Provider calls running at the same time. */
  maxConcurrent: number;
}

/**
 * Safe defaults, kept in code (M1 on #12): well under the GCP quota of 100 per API per day. The environment can only
 * lower them; a larger value is refused so a typo cannot raise spending.
 */
export const SAFE_DEFAULT_LIMITS: UsageLimits = {
  dailyPerSku: {
    [SKU.placesTextSearchPro]: 20,
    [SKU.placesTextSearchEnterprise]: 20,
    [SKU.routesDrive]: 20,
    [SKU.routesTransit]: 20,
  },
  maxCallsPerInput: 8,
  maxConcurrent: 2,
};

/** Environment variable per setting. Unset or empty keeps the default. */
export const LIMIT_ENV = {
  daily: 'TRAVEL_DAILY_LIMIT_PER_SKU',
  perInput: 'TRAVEL_MAX_CALLS_PER_INPUT',
  concurrent: 'TRAVEL_MAX_CONCURRENT',
} as const;

function lowered(env: Readonly<Record<string, string | undefined>>, name: string, max: number, min: number): number {
  const raw = env[name]?.trim();
  if (!raw) return max;
  if (!/^\d+$/.test(raw)) throw new Error(`invalid ${name}: expected an integer from ${min} to ${max}`);
  const value = Number(raw);
  if (value > max) throw new Error(`${name}=${raw} is above the safe default ${max}; it can only be lowered`);
  if (value < min) throw new Error(`invalid ${name}: expected an integer from ${min} to ${max}`);
  return value;
}

/**
 * Reads the usage limits for the shared server (apps/server passes its env). Throws on an invalid or raised value,
 * so the server refuses to start rather than spend more than intended.
 */
export function usageLimitsFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): UsageLimits {
  const d = SAFE_DEFAULT_LIMITS;
  // One daily value for every SKU, capped at the smallest default so no SKU is raised.
  const dailyMax = Math.min(...Object.values(d.dailyPerSku));
  const daily = lowered(env, LIMIT_ENV.daily, dailyMax, 0);
  const dailyPerSku = Object.fromEntries(Object.entries(d.dailyPerSku).map(([sku, max]) => [sku, Math.min(max, daily)])) as Record<Sku, number>;
  return {
    dailyPerSku,
    maxCallsPerInput: lowered(env, LIMIT_ENV.perInput, d.maxCallsPerInput, 0),
    maxConcurrent: lowered(env, LIMIT_ENV.concurrent, d.maxConcurrent, 1),
  };
}

/**
 * The shared, process-wide pieces built from the limits. Note: DailyQuota counts in memory, so restarting the server
 * (including `tsx watch` reloads) starts the day's count from 0 again; the GCP quota (100/day per API, 429 not
 * retried) stays the final stop. Move the count to the DB if the server ever runs as several processes (M1, #12).
 */
export function createUsageControls(limits: UsageLimits, clock?: Clock): { quota: DailyQuota; gate: Gate } {
  return { quota: new DailyQuota(limits.dailyPerSku, clock), gate: new Gate(limits.maxConcurrent) };
}
