import type { LatLng, PlaceInfo, TimeZone } from '@tkb/contracts';
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

/** Wraps a provider and records why each pair came back without a leg (e.g. no_route after the last train). */
export function recordingRoutes(inner: RouteProvider, sink: Map<string, RouteUnknownReason>): RouteProvider {
  return {
    async route(request, budget) {
      const r = await inner.route(request, budget);
      if (!r.leg && r.reason) sink.set(reasonKey(request.from.placeId, request.to.placeId, request.mode, request.departureUtc), r.reason);
      return r;
    },
  };
}
