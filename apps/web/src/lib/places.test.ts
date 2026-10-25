import { describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import { highlightFor, itemKey, itemPlaceIds, numberEntries, numberPlaces } from './places.ts';

describe('places sync', () => {
  const trip = fixtureTrips[0]!;
  const day = trip.days[0]!;
  it('numbers places from 1 without duplicates; the gaps are the derived stops (UI review on #34)', () => {
    const n = numberPlaces(day, trip.places);
    const all = numberEntries(day, trip.places);
    expect(all.map(x => x.number)).toEqual(all.map((_, i) => i + 1));
    expect(n.map(x => x.number)).toEqual(all.filter(x => x.kind === 'place').map(x => x.number));
    expect(all.filter(x => x.kind === 'stop').map(x => x.kind === 'stop' && x.name)).toEqual(['武蔵ヶ辻・近江町市場', '武蔵ヶ辻・近江町市場']);
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
