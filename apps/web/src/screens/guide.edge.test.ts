/**
 * U01 independent tests: the guide entry point around daylight saving time, several time zones in one trip,
 * and activity statuses. pickGuideTarget must follow the local calendar date of each DAY's own zone.
 */
import { describe, expect, it } from 'vitest';
import type { Activity, Trip, TripDay } from '@tkb/contracts';
import { createMockApi } from '../mocks/index.ts';
import { localDateIn, pickGuideTarget } from './guide.ts';

async function fixtureTrip(tripId: string): Promise<Trip> {
  const r = await createMockApi().getTrip(tripId);
  if (!r.ok) throw new Error(`fixture ${tripId}`);
  return r.data;
}

const iso = (s: string) => new Date(s);

describe('localDateIn around daylight saving changes', () => {
  it('Paris, end of summer time (2026-10-25 03:00 CEST -> 02:00 CET at 01:00Z)', () => {
    expect(localDateIn(iso('2026-10-24T21:59:59Z'), 'Europe/Paris')).toBe('2026-10-24'); // 23:59:59 CEST
    expect(localDateIn(iso('2026-10-24T22:00:00Z'), 'Europe/Paris')).toBe('2026-10-25'); // 00:00 CEST
    // after the clocks went back the offset is +1: 22:59Z is still 23:59 on the 25th, 23:00Z is the 26th.
    expect(localDateIn(iso('2026-10-25T22:59:59Z'), 'Europe/Paris')).toBe('2026-10-25');
    expect(localDateIn(iso('2026-10-25T23:00:00Z'), 'Europe/Paris')).toBe('2026-10-26');
  });

  it('New York, start of summer time (2026-03-08 at 07:00Z)', () => {
    expect(localDateIn(iso('2026-03-08T04:59:59Z'), 'America/New_York')).toBe('2026-03-07'); // 23:59:59 EST
    expect(localDateIn(iso('2026-03-08T05:00:00Z'), 'America/New_York')).toBe('2026-03-08'); // 00:00 EST
    // after the change the offset is -4: midnight of the 9th is 04:00Z
    expect(localDateIn(iso('2026-03-09T03:59:59Z'), 'America/New_York')).toBe('2026-03-08');
    expect(localDateIn(iso('2026-03-09T04:00:00Z'), 'America/New_York')).toBe('2026-03-09');
  });

  it('Sydney, southern hemisphere summer time starts in October (2026-10-04 at 16:00Z on the 3rd)', () => {
    expect(localDateIn(iso('2026-10-03T13:59:59Z'), 'Australia/Sydney')).toBe('2026-10-03'); // 23:59:59 AEST (+10)
    expect(localDateIn(iso('2026-10-03T14:00:00Z'), 'Australia/Sydney')).toBe('2026-10-04'); // 00:00 AEST
    expect(localDateIn(iso('2026-10-04T12:59:59Z'), 'Australia/Sydney')).toBe('2026-10-04'); // 23:59:59 AEDT (+11)
    expect(localDateIn(iso('2026-10-04T13:00:00Z'), 'Australia/Sydney')).toBe('2026-10-05');
  });

  it('a zone without daylight saving (Tokyo) is exactly UTC+9 all year', () => {
    expect(localDateIn(iso('2026-06-30T14:59:59Z'), 'Asia/Tokyo')).toBe('2026-06-30');
    expect(localDateIn(iso('2026-06-30T15:00:00Z'), 'Asia/Tokyo')).toBe('2026-07-01');
    expect(localDateIn(iso('2026-12-31T15:00:00Z'), 'Asia/Tokyo')).toBe('2027-01-01');
  });

  it('is always zero-padded YYYY-MM-DD (so it compares as a string with LocalDate)', () => {
    for (const t of ['2026-01-02T00:00:00Z', '2026-09-09T12:00:00Z', '2027-12-31T23:59:59Z']) {
      for (const tz of ['Asia/Tokyo', 'Europe/Paris', 'America/Los_Angeles', 'UTC']) expect(localDateIn(iso(t), tz)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe('pickGuideTarget on the Paris fixture (the trip crosses the end of summer time)', () => {
  it('uses the Paris date even when UTC is still the previous day', async () => {
    const trip = await fixtureTrip('fx_trip_paris');
    // 22:30Z on the 24th is 00:30 on the 25th in Paris: day 2 is "today"
    const t = pickGuideTarget(trip, iso('2026-10-24T22:30:00Z'));
    expect(t.reason).toBe('today');
    expect(t.day?.date).toBe('2026-10-25');
    // 21:59Z is still the 24th in Paris
    expect(pickGuideTarget(trip, iso('2026-10-24T21:59:00Z')).day?.date).toBe('2026-10-24');
  });

  it('after the clock change the second day lasts until 23:00Z, then the trip is over', async () => {
    const trip = await fixtureTrip('fx_trip_paris');
    expect(pickGuideTarget(trip, iso('2026-10-25T22:59:00Z'))).toMatchObject({ reason: 'today' });
    const over = pickGuideTarget(trip, iso('2026-10-25T23:00:00Z'));
    expect(over.reason).toBe('past');
    expect(over.day?.date).toBe('2026-10-25'); // last day
  });

  it('before the trip the first day is "upcoming"', async () => {
    const trip = await fixtureTrip('fx_trip_paris');
    const t = pickGuideTarget(trip, iso('2026-10-20T12:00:00Z'));
    expect(t.reason).toBe('upcoming');
    expect(t.day?.date).toBe('2026-10-24');
  });
});

describe('pickGuideTarget: several time zones in one trip and activity statuses', () => {
  it('each day is judged in its own zone', async () => {
    const base = await fixtureTrip('fx_trip_kanazawa');
    const [first] = base.days;
    if (!first) throw new Error('day');
    const tokyoDay: TripDay = { ...first, date: '2026-11-02', timeZone: 'Asia/Tokyo' };
    const nyDay: TripDay = { ...first, date: '2026-11-02', timeZone: 'America/New_York' };
    const trip: Trip = { ...base, days: [tokyoDay, nyDay] };

    // 20:00Z on 11-01: Tokyo is already 11-02 05:00, New York is still 11-01 16:00 -> the Tokyo day is today
    const a = pickGuideTarget(trip, iso('2026-11-01T20:00:00Z'));
    expect(a.reason).toBe('today');
    expect(a.day?.timeZone).toBe('Asia/Tokyo');

    // 20:00Z on 11-02: Tokyo is 11-03, New York is 11-02 15:00 -> the New York day is today
    const b = pickGuideTarget(trip, iso('2026-11-02T20:00:00Z'));
    expect(b.reason).toBe('today');
    expect(b.day?.timeZone).toBe('America/New_York');

    // 06:00Z on 11-03: Tokyo 11-03 15:00 and New York 11-03 01:00 -> both days are over
    expect(pickGuideTarget(trip, iso('2026-11-03T06:00:00Z')).reason).toBe('past');
  });

  it('skips completed and skipped activities; the next two planned ones are next and following', async () => {
    const trip = await fixtureTrip('fx_trip_kanazawa');
    const day = trip.days[0];
    if (!day) throw new Error('day');
    const activities = day.items.filter((i): i is Activity => i.type === 'activity');
    expect(activities.length).toBeGreaterThanOrEqual(4);
    let n = 0;
    const items = day.items.map(i => {
      if (i.type !== 'activity') return i;
      n += 1;
      return { ...i, status: n === 1 ? ('completed' as const) : n === 2 ? ('skipped' as const) : ('planned' as const) };
    });
    const t = pickGuideTarget({ ...trip, days: [{ ...day, items }, ...trip.days.slice(1)] }, iso('2026-11-01T01:00:00Z'));
    expect(t.reason).toBe('today');
    expect(t.next?.activityId).toBe(activities[2]?.activityId);
    expect(t.following?.activityId).toBe(activities[3]?.activityId);
  });

  it('when everything today is done there is no next item, but the day stays "today" (it does not jump ahead)', async () => {
    const trip = await fixtureTrip('fx_trip_kanazawa');
    const day = trip.days[0];
    if (!day) throw new Error('day');
    const items = day.items.map(i => (i.type === 'activity' ? { ...i, status: 'completed' as const } : i));
    const t = pickGuideTarget({ ...trip, days: [{ ...day, items }, ...trip.days.slice(1)] }, iso('2026-11-01T01:00:00Z'));
    expect(t.reason).toBe('today');
    expect(t.day?.date).toBe('2026-11-01');
    expect(t.next).toBeNull();
    expect(t.following).toBeNull();
  });

  it('a day made only of legs has no next item, and only one planned activity gives no following item', async () => {
    const trip = await fixtureTrip('fx_trip_kanazawa');
    const day = trip.days[0];
    if (!day) throw new Error('day');
    const legsOnly = day.items.filter(i => i.type === 'leg');
    const t = pickGuideTarget({ ...trip, days: [{ ...day, items: legsOnly }] }, iso('2026-11-01T01:00:00Z'));
    expect(t.next).toBeNull();

    const firstActivity = day.items.find(i => i.type === 'activity');
    if (!firstActivity) throw new Error('activity');
    const one = pickGuideTarget({ ...trip, days: [{ ...day, items: [firstActivity] }] }, iso('2026-11-01T01:00:00Z'));
    expect(one.next).not.toBeNull();
    expect(one.following).toBeNull();
  });

  it('a trip without days is "none" and never throws, whatever the clock says', async () => {
    const trip = await fixtureTrip('fx_trip_kanazawa');
    for (const now of ['1970-01-01T00:00:00Z', '2026-11-01T00:00:00Z', '2999-12-31T23:59:59Z']) {
      expect(pickGuideTarget({ ...trip, days: [] }, iso(now))).toEqual({ reason: 'none', day: null, next: null, following: null });
    }
  });

  it('does not mutate the trip it reads', async () => {
    const trip = await fixtureTrip('fx_trip_paris');
    const before = structuredClone(trip);
    pickGuideTarget(trip, iso('2026-10-25T00:00:00Z'));
    expect(trip).toEqual(before);
  });
});
