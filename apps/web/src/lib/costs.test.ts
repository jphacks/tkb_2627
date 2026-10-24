import { describe, expect, it } from 'vitest';
import { fixtureTrips } from '@tkb/fixtures';
import type { Activity, Trip } from '@tkb/contracts';
import { summarizeCosts } from './costs.ts';

const tz = 'Asia/Tokyo';
const act = (id: string, cost: Activity['cost']): Activity => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: null, areaName: null,
  start: null, end: null, fixed: false, status: 'planned', cost, costStatus: cost ? 'fixture' : 'unknown', privateNotes: null,
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
