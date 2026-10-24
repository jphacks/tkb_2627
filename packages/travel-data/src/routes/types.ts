import type { PlaceInfo, TravelLeg, UtcInstant } from '@tkb/contracts';
import type { CallBudget } from '../policy/budget.ts';

/**
 * Why no leg (or no detail) came back. Never filled in by guessing (docs/01_SPEC.md):
 * - `no_route`: the provider returned no route (e.g. after the last service of the day, or no connection).
 * - `unsupported_region`: no transit route in a region where the provider is known not to return transit
 *   (Japan, docs/provider-probe.md).
 * - `out_of_date_range`: the departure is outside what the provider accepts (transit: 7 days back to 100 days ahead).
 * - `missing_location`: a place has no coordinates to route from or to.
 * - `rate_limited` / `provider_unavailable`: our limit or the provider stopped the call (D02).
 */
export type RouteUnknownReason =
  | 'no_route'
  | 'unsupported_region'
  | 'out_of_date_range'
  | 'missing_location'
  | 'rate_limited'
  | 'provider_unavailable';

export interface RouteRequest {
  from: PlaceInfo;
  to: PlaceInfo;
  /** Requested departure (K06 RouteQuery.departureUtc). */
  departureUtc: UtcInstant;
  mode: TravelLeg['mode'];
}

/** A leg, or null with the reason. A leg's fare, platform and times may still be null when the provider did not return them. */
export interface RouteResult {
  leg: TravelLeg | null;
  reason: RouteUnknownReason | null;
}

/** K06 adapter for one segment. Calls go through the input's CallBudget (D02); cancellation is rethrown. */
export interface RouteProvider {
  route(request: RouteRequest, budget: CallBudget): Promise<RouteResult>;
}

/** Deterministic leg ID within the [A-Za-z0-9_-]{1,128} Id format, from the segment and departure. */
export function legIdFor(request: RouteRequest): string {
  const text = `${request.from.placeId}|${request.to.placeId}|${request.mode}|${request.departureUtc}`;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `leg_${request.mode}_${h1.toString(36)}${h2.toString(36)}`;
}
