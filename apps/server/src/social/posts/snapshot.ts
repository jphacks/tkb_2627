import { PostSnapshot, PublicActivity, PublicTripConstraints, type PlaceInfo, type PublicTripDay, type Trip } from '@tkb/contracts';

export const REDACTION_VERSION = 1;

/** Provider data may be republished only when export is allowed, storage is allowed and it has no retention deadline. */
const publishable = (p: PlaceInfo): boolean =>
  p.provenance.mayExport && p.provenance.mayStore && p.provenance.retainUntil === null;

/**
 * Builds the public snapshot from the stored trip (server side only). Everything is an allow-list:
 * - constraints and activities are picked (budget, departure/return, privateNotes never copied);
 * - places are limited to those days reference, that are publishable and are not the home
 *   (constraints.departure/return placeId);
 * - activities at the home are dropped; activities pointing at another withheld place get
 *   placeId=null; legs touching the home are removed
 *   (times and lines would hint at it); legs touching other withheld places use opaque ids;
 * - legs whose provenance forbids export lose their provider data.
 */
export function buildSnapshot(trip: Trip): { snapshot: PostSnapshot; redactedFields: string[] } {
  // preciseCurrentLocation is never stored on a trip; the others are listed whenever the field is present.
  const removed = new Set<string>(['preciseCurrentLocation', 'privateNotes']);
  const c = trip.constraints;
  for (const k of ['budget', 'departure', 'return', 'mustVisit', 'preferences'] as const) {
    if (c[k] !== undefined && c[k] !== null) removed.add(k);
  }
  if (c.departure || c.return) removed.add('homeAddress');
  const constraints = PublicTripConstraints.parse(c);

  const home = new Set<string>();
  for (const e of [c.departure, c.return]) if (e?.placeId) home.add(e.placeId);

  const eligible = new Map<string, PlaceInfo>();
  for (const p of trip.places) if (!home.has(p.placeId) && publishable(p)) eligible.set(p.placeId, p);

  const opaque = new Map<string, string>();
  const hide = (id: string): string => {
    let o = opaque.get(id);
    if (!o) {
      o = `hidden_${opaque.size + 1}`;
      opaque.set(id, o);
    }
    return o;
  };
  const referenced = new Set<string>();

  const days: PublicTripDay[] = trip.days.map((d) => ({
    date: d.date,
    timeZone: d.timeZone,
    items: d.items.flatMap((it): PublicTripDay['items'] => {
      if (it.type === 'activity') {
        const pub = PublicActivity.parse(it);
        if (it.privateNotes) removed.add('privateNotes');
        // A stop at the home (e.g. "自宅を出発") is dropped entirely: its title and times would reveal it.
        if (it.placeId && home.has(it.placeId)) {
          removed.add('homeActivities');
          return [];
        }
        if (it.placeId && !eligible.has(it.placeId)) {
          removed.add('placeReference');
          return [{ ...pub, placeId: null }];
        }
        if (it.placeId) referenced.add(it.placeId);
        return [pub];
      }
      if (home.has(it.fromPlaceId) || home.has(it.toPlaceId)) {
        removed.add('homeLegs');
        return [];
      }
      let leg = it;
      if (leg.provenance && !leg.provenance.mayExport) {
        removed.add('legProviderData');
        leg = {
          ...leg,
          departure: null,
          arrival: null,
          durationSeconds: null,
          lineName: null,
          platform: null,
          transfers: null,
          fare: null,
          dataStatus: 'unavailable',
          provenance: null,
        };
      }
      const ends = [leg.fromPlaceId, leg.toPlaceId].map((id) => {
        if (eligible.has(id)) {
          referenced.add(id);
          return id;
        }
        removed.add('placeReference');
        return hide(id);
      });
      return [{ ...leg, fromPlaceId: ends[0]!, toPlaceId: ends[1]! }];
    }),
  }));

  const places: PlaceInfo[] = [];
  for (const id of referenced) {
    const p = eligible.get(id)!;
    // A photo without a stated license is not republished.
    places.push(p.photo && p.photo.license === null ? { ...p, photo: null } : p);
  }
  if (trip.places.some((p) => !eligible.has(p.placeId) && !home.has(p.placeId))) removed.add('placeProviderData');

  const snapshot = PostSnapshot.parse({
    schemaVersion: trip.schemaVersion,
    title: trip.title,
    constraints,
    days,
    places,
    redactionVersion: REDACTION_VERSION,
  });
  return { snapshot, redactedFields: [...removed] };
}
