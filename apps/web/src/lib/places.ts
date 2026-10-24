import type { ItineraryItem, PlaceInfo, TripDay } from '@tkb/contracts';

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

/** Places referenced by the day, numbered in order of first appearance. */
export function numberPlaces(day: TripDay, places: PlaceInfo[]): NumberedPlace[] {
  const byId = new Map(places.map(p => [p.placeId, p]));
  const seen = new Set<string>();
  const out: NumberedPlace[] = [];
  for (const item of day.items) {
    for (const id of itemPlaceIds(item)) {
      const place = byId.get(id);
      if (!place || seen.has(id)) continue;
      seen.add(id);
      out.push({ number: out.length + 1, place });
    }
  }
  return out;
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
