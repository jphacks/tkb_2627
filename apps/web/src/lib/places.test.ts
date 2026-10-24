import { describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import { highlightFor, itemKey, itemPlaceIds, numberPlaces } from './places.ts';

describe('places sync', () => {
  const trip = fixtureTrips[0]!;
  const day = trip.days[0]!;
  it('numbers places from 1 without duplicates', () => {
    const n = numberPlaces(day, trip.places);
    expect(n.map(x => x.number)).toEqual(n.map((_, i) => i + 1));
    expect(new Set(n.map(x => x.place.placeId)).size).toBe(n.length);
  });
  it('item selection highlights its places and place selection highlights its items', () => {
    const item = day.items.find(i => itemPlaceIds(i).length > 0)!;
    const h = highlightFor({ kind: 'item', key: itemKey(item) }, day);
    expect(h.placeIds.size).toBeGreaterThan(0);
    const pid = itemPlaceIds(item)[0]!;
    expect(highlightFor({ kind: 'place', placeId: pid }, day).itemKeys.has(itemKey(item))).toBe(true);
    expect(highlightFor(null, day).itemKeys.size).toBe(0);
  });
});
