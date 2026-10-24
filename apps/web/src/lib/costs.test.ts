import { describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import type { Activity, Trip, TravelLeg } from '@tkb/contracts';
import { summarizeCosts } from './costs.ts';

const tz = 'Asia/Tokyo';
const act = (id: string, cost: Activity['cost']): Activity => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: null, areaName: null,
  start: null, end: null, fixed: false, status: 'planned', cost, costStatus: cost ? 'fixture' : 'unknown', privateNotes: null,
});

const leg = (id: string, mode: TravelLeg['mode'], fare: TravelLeg['fare']): TravelLeg => ({
  type: 'leg', legId: id, mode, fromPlaceId: 'p1', toPlaceId: 'p2', departure: null, arrival: null, durationSeconds: null,
  lineName: null, platform: null, transfers: null, fare, dataStatus: fare ? 'fixture' : 'unknown', provenance: null,
});

describe('summarizeCosts', () => {
  it('sums per currency without merging and counts nulls as unknown, not zero', () => {
    const days: Trip['days'] = [
      { date: '2026-11-01', timeZone: tz, items: [
        act('a', { amountMinor: 500, currency: 'JPY' }),
        act('b', { amountMinor: 300, currency: 'JPY' }),
        act('c', { amountMinor: 1250, currency: 'EUR' }),
        act('d', null),
      ] },
      { date: '2026-11-02', timeZone: tz, items: [act('e', null)] },
    ];
    const s = summarizeCosts(days);
    expect(s.totals).toEqual([{ currency: 'EUR', amountMinor: 1250 }, { currency: 'JPY', amountMinor: 800 }]);
    expect(s.unknownCount).toBe(2);
  });

  it('does not count walking legs as cost items; non-walking legs without a fare stay unknown', () => {
    const days: Trip['days'] = [
      { date: '2026-11-01', timeZone: tz, items: [
        leg('w1', 'walk', null),
        leg('t1', 'transit', null),
        leg('t2', 'transit', { amountMinor: 210, currency: 'JPY' }),
        leg('c1', 'car', null),
        act('a', null),
        leg('w2', 'walk', null),
      ] },
    ];
    const s = summarizeCosts(days);
    expect(s.totals).toEqual([{ currency: 'JPY', amountMinor: 210 }]);
    expect(s.unknownCount).toBe(3); // t1, c1, a. Not w1 / w2.
  });

  it('a day with only walking legs has no totals and no unknown items', () => {
    expect(summarizeCosts([{ date: '2026-11-01', timeZone: tz, items: [leg('w', 'walk', null)] }])).toEqual({ totals: [], unknownCount: 0 });
  });

  it('returns no totals when everything is unknown', () => {
    expect(summarizeCosts([{ date: '2026-11-01', timeZone: tz, items: [act('a', null)] }])).toEqual({ totals: [], unknownCount: 1 });
  });

  it('handles fixture trips', () => {
    for (const t of fixtureTrips) {
      const s = summarizeCosts(t.days);
      expect(new Set(s.totals.map(m => m.currency)).size).toBe(s.totals.length);
    }
  });
});
