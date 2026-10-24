import type { PlaceInfo, Trip, TravelLeg } from '@tkb/contracts';

/** Shown next to every Maps link (R18): opening a link is not saving the places to the user's Google account. */
export const MAPS_LINK_NOTICE =
  'Googleマップで地点・経路を開くリンクです。Googleアカウントの保存済みリストやマイマップへの自動登録は行いません（この機能は提供していません）。';

/** Official Maps URLs limit (https://developers.google.com/maps/documentation/urls/get-started). */
export const MAPS_URL_MAX_LENGTH = 2048;
/** Mobile browsers support 3 waypoints, other platforms 9. The default stays on the safe side. */
export const MAPS_MOBILE_MAX_WAYPOINTS = 3;
export const MAPS_MAX_WAYPOINTS = 9;

export type MapsTravelMode = 'driving' | 'walking' | 'transit';

export interface MapsLink {
  kind: 'search' | 'directions';
  url: string;
  /** Place IDs (ours, not Google place IDs) covered by this link, in order. */
  placeIds: string[];
  travelMode: MapsTravelMode | null;
}

const SEARCH = 'https://www.google.com/maps/search/?api=1';
const DIRECTIONS = 'https://www.google.com/maps/dir/?api=1';

/**
 * Coordinates when known (unambiguous, fixed 6 decimals so no exponent), otherwise the place name, followed by
 * `areaHint` (e.g. the trip area) so a common name does not open a same-named place elsewhere.
 * encodeURIComponent turns , into %2C and | into %7C.
 */
function point(place: PlaceInfo, areaHint?: string): string {
  if (place.location) return `${place.location.lat.toFixed(6)},${place.location.lng.toFixed(6)}`;
  return areaHint && !place.name.includes(areaHint) ? `${place.name} ${areaHint}` : place.name;
}

/** Official search URL that opens one place. */
export function placeSearchLink(place: PlaceInfo, areaHint?: string): MapsLink {
  return { kind: 'search', url: `${SEARCH}&query=${encodeURIComponent(point(place, areaHint))}`, placeIds: [place.placeId], travelMode: null };
}

function directionsUrl(stops: readonly PlaceInfo[], mode: MapsTravelMode, areaHint?: string): string {
  const enc = (p: PlaceInfo) => encodeURIComponent(point(p, areaHint));
  // `|` separates waypoints and encodes to the same %7C, so a name containing it would split into two stops.
  const encVia = (p: PlaceInfo) => encodeURIComponent(point(p, areaHint).replace(/[|｜]/g, ' '));
  const via = stops.slice(1, -1);
  return (
    `${DIRECTIONS}&origin=${enc(stops[0]!)}&destination=${enc(stops.at(-1)!)}` +
    (via.length > 0 ? `&waypoints=${via.map(encVia).join('%7C')}` : '') +
    `&travelmode=${mode}`
  );
}

export interface RouteLinkOptions {
  /** Waypoints per URL, 0-9; defaults to the mobile limit (3), and is always 0 for transit. */
  maxWaypoints?: number;
  /** Added after the name of a place without coordinates (tripMapsLinks passes the trip area). */
  areaHint?: string;
}

export interface RouteLinks {
  links: MapsLink[];
  /** Consecutive stops whose single segment is still longer than MAPS_URL_MAX_LENGTH (very long names without coordinates). */
  tooLong: [string, string][];
}

/**
 * Official directions URLs through `stops` in order. A long route is split into several URLs, each starting where
 * the previous one ended, so every URL keeps within the waypoint and 2,048-character limits. Transit gets one URL per
 * segment: the Maps URLs docs do not promise waypoints for transit, and an ignored waypoint would show a wrong route.
 */
export function routeLinks(stops: readonly PlaceInfo[], mode: MapsTravelMode, options: RouteLinkOptions = {}): RouteLinks {
  const requested = Number.isFinite(options.maxWaypoints) ? Math.floor(options.maxWaypoints!) : MAPS_MOBILE_MAX_WAYPOINTS;
  const maxWaypoints = mode === 'transit' ? 0 : Math.min(MAPS_MAX_WAYPOINTS, Math.max(0, requested));
  const links: MapsLink[] = [];
  const tooLong: [string, string][] = [];
  let from = 0;
  while (from < stops.length - 1) {
    let to = Math.min(stops.length - 1, from + maxWaypoints + 1);
    while (to > from + 1 && directionsUrl(stops.slice(from, to + 1), mode, options.areaHint).length > MAPS_URL_MAX_LENGTH) to -= 1;
    const chunk = stops.slice(from, to + 1);
    const url = directionsUrl(chunk, mode, options.areaHint);
    if (url.length > MAPS_URL_MAX_LENGTH) tooLong.push([chunk[0]!.placeId, chunk[1]!.placeId]);
    else links.push({ kind: 'directions', url, placeIds: chunk.map(p => p.placeId), travelMode: mode });
    from = to;
  }
  return { links, tooLong };
}

const LEG_MODE: Record<TravelLeg['mode'], MapsTravelMode> = { transit: 'transit', car: 'driving', walk: 'walking' };
const TRIP_MODE: Record<Trip['constraints']['transportMode'], MapsTravelMode> = { transit: 'transit', car: 'driving' };

export interface DayMapsLinks {
  date: string;
  /** One search link per visited place, in order of first visit. */
  places: MapsLink[];
  /** Directions between consecutive places; a run of segments with the same mode shares URLs. */
  routes: MapsLink[];
  tooLong: [string, string][];
}

export interface TripMapsLinks {
  notice: string;
  days: DayMapsLinks[];
  /** Places left out because their provider does not allow export (provenance.mayExport=false, docs/08). */
  withheldPlaceIds: string[];
  /** Place IDs used by activities but missing from `trip.places`, so they could not be linked. */
  unknownPlaceIds: string[];
}

/**
 * Maps links for each day of a trip (K18 format=maps). Uses only places that exist in `trip.places` and may be
 * exported; skipped activities and activities without a place are left out. A segment's mode comes from the itinerary leg between the
 * two places when there is exactly one, otherwise from the trip's transport mode.
 */
export function tripMapsLinks(trip: Pick<Trip, 'days' | 'places' | 'constraints'>, options: RouteLinkOptions = {}): TripMapsLinks {
  const places = new Map(trip.places.filter(p => p.provenance.mayExport).map(p => [p.placeId, p]));
  const known = new Set(trip.places.map(p => p.placeId));
  const withheld = new Set<string>();
  const unknown = new Set<string>();
  const linkOptions = { ...options, areaHint: options.areaHint ?? trip.constraints.area };
  const days = trip.days.map(day => {
    const stops: PlaceInfo[] = [];
    const modes: MapsTravelMode[] = [];
    let legs: TravelLeg[] = [];
    for (const item of day.items) {
      if (item.type === 'leg') {
        legs.push(item);
        continue;
      }
      const place = item.placeId === null ? undefined : places.get(item.placeId);
      if (item.status !== 'skipped' && item.placeId !== null && !place) (known.has(item.placeId) ? withheld : unknown).add(item.placeId);
      if (item.status === 'skipped' || !place) continue;
      if (stops.at(-1)?.placeId !== place.placeId) {
        // Use the leg's mode only when that leg really joins these two stops (a withheld place may sit between them).
        const leg = legs.length === 1 && legs[0]!.fromPlaceId === stops.at(-1)?.placeId && legs[0]!.toPlaceId === place.placeId ? legs[0] : undefined;
        if (stops.length > 0) modes.push(leg ? LEG_MODE[leg.mode] : TRIP_MODE[trip.constraints.transportMode]);
        stops.push(place);
      }
      legs = [];
    }

    const routes: MapsLink[] = [];
    const tooLong: [string, string][] = [];
    for (let i = 0; i < modes.length; ) {
      let j = i;
      while (j + 1 < modes.length && modes[j + 1] === modes[i]) j += 1;
      const run = routeLinks(stops.slice(i, j + 2), modes[i]!, linkOptions);
      routes.push(...run.links);
      tooLong.push(...run.tooLong);
      i = j + 1;
    }
    const seen = new Set<string>();
    const unique = stops.filter(p => !seen.has(p.placeId) && seen.add(p.placeId));
    return { date: day.date, places: unique.map(p => placeSearchLink(p, linkOptions.areaHint)), routes, tooLong };
  });
  return { notice: MAPS_LINK_NOTICE, days, withheldPlaceIds: [...withheld], unknownPlaceIds: [...unknown] };
}
