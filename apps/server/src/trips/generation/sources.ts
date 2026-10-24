import type { DataMode, PlaceInfo } from '@tkb/contracts';
import { domesticTrip, fixtureTrips, kanazawaPlaces } from '@tkb/fixtures';
import {
  CallBudget,
  FixtureRouteProvider,
  GooglePlacesProvider,
  GoogleRoutesProvider,
  PolicyError,
  createUsageControls,
  usageLimitsFromEnv,
  type PlacesProvider,
  type RouteProvider,
} from '@tkb/travel-data';
import type { SharedConfig } from '../../platform/config.ts';

/** Places for an area (K05 input). Provider specifics (Google, fixture) stay behind this interface. */
export interface AreaPlaceSource {
  /** `placeIds` are looked up in the same source; ids it does not know are simply absent from the result. */
  find(req: { area: string; maxPlaces: number; placeIds: readonly string[]; timeZone?: string }, budget: CallBudget): Promise<{ places: PlaceInfo[]; reason: 'no_results' | null }>;
}

export interface ContextSources {
  places: AreaPlaceSource;
  /** null when no route provider is available (legs are then reported unknown). */
  routes: RouteProvider | null;
  /** A fresh per-request budget. Fixture mode charges nothing but keeps the same limits and cancellation. */
  budget(signal: AbortSignal): CallBudget;
  mode: DataMode;
}

const norm = (s: string) => s.normalize('NFKC').trim().toLowerCase();

/** Extra spellings per fixture area (the fixtures only carry one). */
const AREA_ALIASES: Record<string, string[]> = { 金沢: ['kanazawa'], paris: ['パリ'] };

const KIND_RANK: Record<string, number> = { spot: 0, restaurant: 1, area: 2 };

/** area keyword -> places, built once from the B04 fixture trips (constraints.area -> places). */
function fixtureAreaTable(): { keys: string[]; places: readonly PlaceInfo[] }[] {
  return fixtureTrips.map(t => {
    const base = norm(t.constraints.area);
    // The dense sample trip visits more places than the area pool; the K05 pool stays the six area places.
    return { keys: [base, ...(AREA_ALIASES[base] ?? []).map(norm)], places: t === domesticTrip ? kanazawaPlaces : t.places };
  });
}

export class FixtureAreaPlaceSource implements AreaPlaceSource {
  private readonly table = fixtureAreaTable();

  async find(req: { area: string; maxPlaces: number; placeIds: readonly string[]; timeZone?: string }, budget: CallBudget) {
    void budget; // fixture: no provider call, nothing charged
    const a = norm(req.area);
    const hit = this.table.find(e => e.keys.some(k => a.includes(k) || k.includes(a)));
    const pool = hit?.places ?? [];
    const byId = new Map(pool.map(p => [p.placeId, p]));
    const wanted = req.placeIds.map(id => byId.get(id)).filter((p): p is PlaceInfo => p !== undefined);
    const rest = pool
      .filter(p => !req.placeIds.includes(p.placeId))
      .sort((x, y) => (KIND_RANK[x.kind] ?? 3) - (KIND_RANK[y.kind] ?? 3));
    const places = [...wanted, ...rest].slice(0, req.maxPlaces);
    return { places: structuredClone(places), reason: places.length === 0 ? ('no_results' as const) : null };
  }
}

/**
 * PROVIDER_MODE=live: Places text search by the area words (no rectangle: K05 has none), spots first and then
 * restaurants. Needs the trip time zone (Places returns none). Must-visit ids are kept only if the search returns them.
 */
export class GoogleAreaPlaceSource implements AreaPlaceSource {
  constructor(private readonly provider: PlacesProvider) {}

  async find(req: { area: string; maxPlaces: number; placeIds: readonly string[]; timeZone?: string }, budget: CallBudget) {
    if (!req.timeZone) throw new PolicyError('VALIDATION_FAILED', 'timeZone is required for a live place search', false);
    const each = Math.max(1, Math.ceil(req.maxPlaces / 2));
    const found = new Map<string, PlaceInfo>();
    let failure: PolicyError | null = null;
    for (const suffix of ['観光', 'レストラン']) {
      const r = await this.provider.searchText({ query: `${req.area} ${suffix}`, timeZone: req.timeZone, maxResults: each, languageCode: 'ja' }, budget);
      if (r.reason === 'rate_limited') failure = new PolicyError('PROVIDER_RATE_LIMIT', 'provider limit reached', false);
      else if (r.reason === 'provider_unavailable') failure = new PolicyError('PROVIDER_UNAVAILABLE', 'provider unavailable', true);
      for (const p of r.places) if (!found.has(p.placeId)) found.set(p.placeId, p);
    }
    if (found.size === 0 && failure) throw failure;
    const wanted = req.placeIds.flatMap(id => (found.has(id) ? [found.get(id)!] : []));
    const rest = [...found.values()].filter(p => !req.placeIds.includes(p.placeId));
    const places = [...wanted, ...rest].slice(0, req.maxPlaces);
    return { places, reason: places.length === 0 ? ('no_results' as const) : null };
  }
}

let controls: ReturnType<typeof createUsageControls> | null = null;
let controlsFor = '';

/**
 * Builds the per-process pieces once (daily quota and gate are shared by every request).
 * fixture: fixture places and legs. mixed: fixture places, live Google routes. live: Google places and routes.
 * The key comes from `env` here and is not kept anywhere else; startup (loadConfig) already refused a missing key.
 */
export function createContextSources(
  config: Pick<SharedConfig, 'providerMode'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
  opts: { fetch?: typeof fetch; now?: () => number } = {},
): ContextSources {
  const limits = usageLimitsFromEnv(env);
  const key = JSON.stringify(limits);
  if (!controls || controlsFor !== key) {
    controls = createUsageControls(limits);
    controlsFor = key;
  }
  const { quota, gate } = controls;
  const budget = (signal: AbortSignal) => new CallBudget({ maxCalls: limits.maxCallsPerInput, quota, gate, signal });
  const mode = config.providerMode;
  if (mode === 'fixture') return { places: new FixtureAreaPlaceSource(), routes: new FixtureRouteProvider(), budget, mode };
  const apiKey = (env.GOOGLE_MAPS_SERVER_KEY ?? '').trim();
  if (!apiKey) throw new Error(`planning-context: PROVIDER_MODE=${mode} requires GOOGLE_MAPS_SERVER_KEY`);
  const google = { apiKey, fetch: opts.fetch, now: opts.now };
  return {
    places: mode === 'live' ? new GoogleAreaPlaceSource(new GooglePlacesProvider(google)) : new FixtureAreaPlaceSource(),
    routes: new GoogleRoutesProvider(google),
    budget,
    mode,
  };
}
