import type { Money, TravelLeg, UtcInstant, ZonedTime } from '@tkb/contracts';
import { PolicyError, providerError, type CallBudget } from '../policy/budget.ts';
import { SKU } from '../policy/limits.ts';
import { provenanceFor } from '../policy/retention.ts';
import { legIdFor, type RouteProvider, type RouteRequest, type RouteResult } from './types.ts';

const ENDPOINT = 'https://routes.googleapis.com/directions/v2:computeRoutes';
const DAY_MS = 86_400_000;
/** Routes API transit: departure from 7 days before now up to 100 days after (S12, docs/provider-probe.md). */
const TRANSIT_PAST_MS = 7 * DAY_MS;
const TRANSIT_FUTURE_MS = 100 * DAY_MS;

const BASE_FIELDS = ['routes.duration', 'routes.distanceMeters'];
const TRANSIT_FIELDS = [
  ...BASE_FIELDS,
  'routes.legs.steps.travelMode',
  'routes.legs.steps.staticDuration',
  'routes.legs.steps.transitDetails',
  'routes.travelAdvisory.transitFare',
];
const TRAVEL_MODE = { transit: 'TRANSIT', car: 'DRIVE', walk: 'WALK' } as const;

/** Time zones where the provider returned no transit at all in D01 (Kanazawa 2 km and Kanazawa-Tokyo, #84/#89). */
const NO_TRANSIT_ZONES = new Set(['Asia/Tokyo']);

// ---- Response shape (only the fields we ask for in the field mask; all optional) ----
interface GMoney {
  currencyCode?: string;
  units?: string | number;
  nanos?: number;
}
interface GStop {
  name?: string;
}
interface GTransitDetails {
  stopDetails?: { departureStop?: GStop; departureTime?: string; arrivalStop?: GStop; arrivalTime?: string };
  transitLine?: { name?: string; nameShort?: string };
}
interface GStep {
  travelMode?: string;
  staticDuration?: string;
  transitDetails?: GTransitDetails;
}
interface GRoute {
  duration?: string;
  distanceMeters?: number;
  legs?: { steps?: GStep[] }[];
  travelAdvisory?: { transitFare?: GMoney };
}
interface GResponse {
  routes?: GRoute[];
}

/** "1234s" / "12.5s" → whole seconds; anything else is unknown. */
export function parseDuration(value: string | undefined): number | null {
  const m = value === undefined ? null : /^(\d+(?:\.\d+)?)s$/.exec(value);
  return m ? Math.round(Number(m[1])) : null;
}

/** RFC 3339 timestamp from the provider → contract UtcInstant (Z, no offset); null when unreadable. */
function toUtc(value: string | undefined): UtcInstant | null {
  const ms = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * google.type.Money → minor units of its currency; null when absent, malformed or negative. Minor-unit digits come
 * from Intl (CLDR), as in apps/web; for a few currencies (IQD, HUF, IDR) that differs from ISO 4217.
 */
export function toMoney(fare: GMoney | undefined): Money | null {
  if (!fare?.currencyCode || !/^[A-Z]{3}$/.test(fare.currencyCode)) return null;
  if (typeof fare.units === 'string' && !/^\d+$/.test(fare.units)) return null;
  const units = Number(fare.units ?? 0);
  const nanos = fare.nanos ?? 0;
  if (!Number.isSafeInteger(units) || !Number.isInteger(nanos) || units < 0 || nanos < 0) return null;
  let digits: number;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency: fare.currencyCode }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return null;
  }
  const amountMinor = units * 10 ** digits + Math.round(nanos / 10 ** (9 - digits));
  return Number.isSafeInteger(amountMinor) ? { amountMinor, currency: fare.currencyCode } : null;
}

export interface GoogleRoutesOptions {
  apiKey: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * K06 route adapter over Routes API computeRoutes (D04, R05/R06). Each call is charged to the input's CallBudget and
 * the shared daily quota (D02). Only values the provider returned are used: platform is always null (the API has no
 * platform field), fare and times stay null when absent. Provenance follows the data policy (not storable, not for
 * the model, not for export until M1 decides).
 */
export class GoogleRoutesProvider implements RouteProvider {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GoogleRoutesOptions) {
    if (!options.apiKey) throw new Error('GoogleRoutesProvider needs an API key');
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async route(request: RouteRequest, budget: CallBudget): Promise<RouteResult> {
    const { from, to, mode } = request;
    if (!from.location || !to.location) return { leg: null, reason: 'missing_location' };
    const departureMs = Date.parse(request.departureUtc);
    if (Number.isNaN(departureMs)) throw new PolicyError('VALIDATION_FAILED', 'departureUtc is not a valid instant', false);
    const now = this.now();
    if (mode === 'transit' && !(departureMs >= now - TRANSIT_PAST_MS && departureMs <= now + TRANSIT_FUTURE_MS)) {
      return { leg: null, reason: 'out_of_date_range' };
    }

    const body = {
      origin: { location: { latLng: { latitude: from.location.lat, longitude: from.location.lng } } },
      destination: { location: { latLng: { latitude: to.location.lat, longitude: to.location.lng } } },
      travelMode: TRAVEL_MODE[mode],
      languageCode: 'ja',
      units: 'METRIC',
      // Only transit is timed: driving and walking durations are not tied to a departure here.
      ...(mode === 'transit' ? { departureTime: request.departureUtc } : {}),
    };
    const fieldMask = (mode === 'transit' ? TRANSIT_FIELDS : BASE_FIELDS).join(',');
    const sku = mode === 'transit' ? SKU.routesTransit : SKU.routesDrive; // walking is charged like driving (Compute Routes)

    let json: GResponse;
    try {
      // Driving and walking are not timed, so requests differing only in departure share one call.
      const key = mode === 'transit' ? legIdFor(request) : `${from.placeId}|${to.placeId}|${mode}`;
      json = await budget.run(sku, key, async signal => {
        let res: Response;
        try {
          res = await this.fetchFn(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.options.apiKey, 'X-Goog-FieldMask': fieldMask },
            body: JSON.stringify(body),
            signal,
          });
        } catch (e) {
          if (signal.aborted) throw e;
          // Never pass the fetch error on: its message can echo header values (the key).
          throw providerError(null);
        }
        if (!res.ok) throw providerError(res.status);
        const parsed: unknown = await res.json().catch(() => undefined);
        // An unreadable 200 is a provider fault, not "no route" (K06 UNAVAILABLE).
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new PolicyError('PROVIDER_UNAVAILABLE', 'unreadable provider response', false);
        }
        return parsed as GResponse;
      });
    } catch (e) {
      if (e instanceof PolicyError && e.code === 'PROVIDER_RATE_LIMIT') return { leg: null, reason: 'rate_limited' };
      if (e instanceof PolicyError && e.code === 'PROVIDER_UNAVAILABLE') return { leg: null, reason: 'provider_unavailable' };
      throw e; // CANCELLED and anything unexpected
    }

    const route = json.routes?.[0];
    if (!route) {
      const unsupported = mode === 'transit' && NO_TRANSIT_ZONES.has(from.timeZone) && NO_TRANSIT_ZONES.has(to.timeZone);
      return { leg: null, reason: unsupported ? 'unsupported_region' : 'no_route' };
    }
    return { leg: this.toLeg(request, route), reason: null };
  }

  /**
   * The leg runs from place to place, so its times are too: boarding time minus the provider's durations of the
   * steps before the first transit step, alighting time plus those after the last one. If any of those is missing,
   * both times stay null (never guessed) and only durationSeconds is kept.
   */
  private toLeg(request: RouteRequest, route: GRoute): TravelLeg {
    const steps = (route.legs ?? []).flatMap(l => l.steps ?? []);
    const isTransitStep = (s: GStep) => s.travelMode === 'TRANSIT' && Boolean(s.transitDetails);
    const transit = steps.filter(isTransitStep);
    const firstIdx = steps.findIndex(isTransitStep);
    const lastIdx = steps.findLastIndex(isTransitStep);
    const sumSeconds = (list: GStep[]) => list.reduce<number | null>((acc, s) => (acc === null ? null : (d => (d === null ? null : acc + d))(parseDuration(s.staticDuration))), 0);
    const before = firstIdx < 0 ? null : sumSeconds(steps.slice(0, firstIdx));
    const after = lastIdx < 0 ? null : sumSeconds(steps.slice(lastIdx + 1));
    const board = toUtc(transit[0]?.transitDetails?.stopDetails?.departureTime);
    const alight = toUtc(transit.at(-1)?.transitDetails?.stopDetails?.arrivalTime);
    const shift = (utc: UtcInstant | null, seconds: number | null): UtcInstant | null =>
      utc === null || seconds === null ? null : new Date(Date.parse(utc) + seconds * 1000).toISOString().replace(/\.000Z$/, 'Z');
    const isTransit = request.mode === 'transit';
    const depUtc = shift(board, before === null ? null : -before);
    const arrUtc = shift(alight, after);
    const timed = isTransit && depUtc !== null && arrUtc !== null;
    const zoned = (utc: UtcInstant | null, timeZone: string): ZonedTime | null => (utc === null ? null : { utc, timeZone });
    const lines = transit.map(s => s.transitDetails?.transitLine?.nameShort || s.transitDetails?.transitLine?.name).filter((n): n is string => Boolean(n));
    return {
      type: 'leg',
      legId: legIdFor(request),
      mode: request.mode,
      fromPlaceId: request.from.placeId,
      toPlaceId: request.to.placeId,
      departure: timed ? zoned(depUtc, request.from.timeZone) : null,
      arrival: timed ? zoned(arrUtc, request.to.timeZone) : null,
      durationSeconds: parseDuration(route.duration),
      lineName: lines.length > 0 ? lines.join(' → ') : null,
      platform: null,
      transfers: isTransit && transit.length > 0 ? transit.length - 1 : null,
      fare: isTransit ? toMoney(route.travelAdvisory?.transitFare) : null,
      dataStatus: 'verified',
      provenance: provenanceFor('google_routes', this.now()),
    };
  }
}
