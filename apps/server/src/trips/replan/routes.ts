import type { LatLng, PlaceInfo, TimeZone } from '@tkb/contracts';
import { toLocal } from '@tkb/planner';
import type { RouteProvider, RouteUnknownReason } from '@tkb/travel-data';

/** The traveller's position as a place, in memory only (D-2): it is never stored, returned or put in an operation. */
export const CURRENT_LOCATION_ID = '_current_location';

export function syntheticCurrentPlace(point: LatLng, timeZone: TimeZone): PlaceInfo {
  return {
    placeId: CURRENT_LOCATION_ID,
    name: '現在地',
    kind: 'other',
    location: { lat: point.lat, lng: point.lng },
    timeZone,
    openingHours: null,
    description: null,
    photo: null,
    dataStatus: 'unknown',
    provenance: { source: 'user_location', fetchedAt: null, attribution: null, maySendToModel: false, mayStore: false, mayExport: false, retainUntil: null },
  };
}

export const reasonKey = (from: string, to: string, mode: string, departureUtc: string) => `${from}>${to}|${mode}|${departureUtc}`;

const LATE_SERVICE_MS = 60 * 60_000;

/**
 * Wraps a provider and records why each pair came back without a leg (e.g. no_route after the last train).
 * B1: a transit answer that departs more than an hour after the asked time, or on a later local date, is the next
 * service (e.g. tomorrow's first train), not a way to travel now: it is turned into `no_route`. A later local date
 * counts even when close in time (23:50 -> 00:05): that is conservatively treated as no route too. Fixture legs carry
 * sample times that do not follow the request, so they are exempt.
 */
export function recordingRoutes(inner: RouteProvider, sink: Map<string, RouteUnknownReason>): RouteProvider {
  return {
    async route(request, budget) {
      let r = await inner.route(request, budget);
      const dep = r.leg?.departure;
      if (r.leg && dep && request.mode === 'transit' && r.leg.dataStatus !== 'fixture') {
        const asked = Date.parse(request.departureUtc);
        const later = toLocal({ utc: dep.utc, timeZone: request.from.timeZone }).date > toLocal({ utc: request.departureUtc, timeZone: request.from.timeZone }).date;
        if (Date.parse(dep.utc) - asked > LATE_SERVICE_MS || later) r = { leg: null, reason: 'no_route' };
      }
      if (!r.leg && r.reason) sink.set(reasonKey(request.from.placeId, request.to.placeId, request.mode, request.departureUtc), r.reason);
      return r;
    },
  };
}
