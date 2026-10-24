import type { RouteProvider } from '@tkb/travel-data';

/**
 * Per-user daily budget of live Routes provider calls, shared by K05 and the A05 alternatives preview.
 * It counts actual provider calls (one per route() that reaches the provider), not requests. In memory: a restart
 * starts the day from 0 again, like the D02 daily quota. The day is the UTC date.
 */
export interface UserRouteBudget {
  /** Reserves one call for the user; false when today's budget is used up. */
  take(userId: string): boolean;
  remaining(userId: string): number;
}

export const MAX_LIVE_ROUTE_CALLS_PER_USER_PER_DAY = 20;

/** LIVE_ROUTE_CALLS_PER_USER_PER_DAY: an integer from 0 to 20 (default 6); anything else is refused at startup. */
export function liveRouteCallsPerUserFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env.LIVE_ROUTE_CALLS_PER_USER_PER_DAY?.trim();
  if (!raw) return 6;
  if (!/^\d+$/.test(raw) || Number(raw) > MAX_LIVE_ROUTE_CALLS_PER_USER_PER_DAY) {
    throw new Error(`invalid LIVE_ROUTE_CALLS_PER_USER_PER_DAY: expected an integer from 0 to ${MAX_LIVE_ROUTE_CALLS_PER_USER_PER_DAY}`);
  }
  return Number(raw);
}

export function createUserRouteBudget(opts: { perDay: number; now?: () => number }): UserRouteBudget {
  const now = opts.now ?? Date.now;
  let day = '';
  const used = new Map<string, number>();
  const roll = () => {
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      used.clear();
    }
  };
  return {
    take(userId) {
      roll();
      const n = used.get(userId) ?? 0;
      if (n >= opts.perDay) return false;
      used.set(userId, n + 1);
      return true;
    },
    remaining(userId) {
      roll();
      return Math.max(0, opts.perDay - (used.get(userId) ?? 0));
    },
  };
}

let shared: { perDay: number; budget: UserRouteBudget } | null = null;
/** The process-wide budget (one counter for K05 and A05). Rebuilt only if the configured limit changes. */
export function sharedUserRouteBudget(env: Readonly<Record<string, string | undefined>> = process.env): UserRouteBudget {
  const perDay = liveRouteCallsPerUserFromEnv(env);
  if (!shared || shared.perDay !== perDay) shared = { perDay, budget: createUserRouteBudget({ perDay }) };
  return shared.budget;
}

/**
 * A RouteProvider that spends the user's daily budget before every call. When it is used up the pair comes back
 * unknown (`rate_limited`), never as an error, and `exhausted()` tells the caller to say so.
 */
export function limitRoutesPerUser(routes: RouteProvider, userId: string, budget: UserRouteBudget): RouteProvider & { exhausted(): boolean } {
  let hit = false;
  return {
    async route(request, callBudget) {
      if (!budget.take(userId)) {
        hit = true;
        return { leg: null, reason: 'rate_limited' };
      }
      return routes.route(request, callBudget);
    },
    exhausted: () => hit,
  };
}
