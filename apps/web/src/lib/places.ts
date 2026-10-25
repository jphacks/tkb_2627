import type { ItineraryItem, PlaceInfo, TravelLeg, TripDay } from '@tkb/contracts';

export interface NumberedPlace {
  number: number;
  place: PlaceInfo;
}

export function itemKey(item: ItineraryItem): string {
  return item.type === 'activity' ? item.activityId : item.legId;
}

export function itemPlaceIds(item: ItineraryItem): string[] {
  if (item.type === 'activity') return item.placeId ? [item.placeId] : [];
  return [item.fromPlaceId, item.toPlaceId];
}

/** A nested activity (parentActivityId): shown inside its parent, never as its own map point. */
export function isChildItem(item: ItineraryItem): boolean {
  return item.type === 'activity' && !!item.parentActivityId;
}

/** Name of the stop a transit leg gets off at, when the provider returned it and it is not already the next stay's place; else null (never guessed). */
export function alightingStopName(leg: TravelLeg, places: readonly PlaceInfo[]): string | null {
  if (leg.mode !== 'transit') return null;
  const name = leg.transit?.alightingStop?.trim();
  if (!name) return null;
  return places.find(p => p.placeId === leg.toPlaceId)?.name === name ? null : name;
}

export type NumberedEntry =
  | { kind: 'place'; number: number; place: PlaceInfo }
  /** A derived spot: the stop a transit leg gets off at (not a PlaceInfo, so it has no map marker). */
  | { kind: 'stop'; number: number; legId: string; name: string };

/** Row key of the derived stop of a leg. */
export const stopKey = (legId: string): string => `${legId}:stop`;

/**
 * The single numbering of a day, shared by the table rows and the map: every spot gets the next number in order of first
 * appearance: the stays' places and the alighting stop of each transit leg (between the leg's origin and destination).
 * Children are not numbered. The map shows the entries that have a location, so its numbers equal the table's.
 */
export function numberEntries(day: TripDay, places: readonly PlaceInfo[]): NumberedEntry[] {
  const byId = new Map(places.map(p => [p.placeId, p]));
  const seen = new Set<string>();
  const out: NumberedEntry[] = [];
  const addPlace = (id: string) => {
    const place = byId.get(id);
    if (!place || seen.has(id)) return;
    seen.add(id);
    out.push({ kind: 'place', number: out.length + 1, place });
  };
  for (const item of day.items) {
    if (isChildItem(item)) continue;
    if (item.type === 'leg') {
      addPlace(item.fromPlaceId);
      const name = alightingStopName(item, places);
      if (name) out.push({ kind: 'stop', number: out.length + 1, legId: item.legId, name });
      addPlace(item.toPlaceId);
    } else {
      for (const id of itemPlaceIds(item)) addPlace(id);
    }
  }
  return out;
}

/** Places of the day with their number from {@link numberEntries} (a gap in the numbers is a derived stop, which has no marker). */
export function numberPlaces(day: TripDay, places: PlaceInfo[]): NumberedPlace[] {
  return numberEntries(day, places).flatMap(e => (e.kind === 'place' ? [{ number: e.number, place: e.place }] : []));
}

export type Selection = { kind: 'item'; key: string } | { kind: 'place'; placeId: string } | null;

/** R08 minimal sync: which item keys and place ids are highlighted for a selection. */
export function highlightFor(sel: Selection, day: TripDay): { itemKeys: Set<string>; placeIds: Set<string> } {
  const itemKeys = new Set<string>();
  const placeIds = new Set<string>();
  if (!sel) return { itemKeys, placeIds };
  if (sel.kind === 'item') {
    itemKeys.add(sel.key);
    const item = day.items.find(i => itemKey(i) === sel.key);
    if (item) itemPlaceIds(item).forEach(id => placeIds.add(id));
  } else {
    placeIds.add(sel.placeId);
    for (const item of day.items) if (itemPlaceIds(item).includes(sel.placeId)) itemKeys.add(itemKey(item));
  }
  return { itemKeys, placeIds };
}
