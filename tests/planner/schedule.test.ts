// R03/R05/R06/R07/R12/R13: 営業時間、時刻依存の移動、固定予定、日跨ぎ。すべて架空フィクスチャ(実在の時刻表・営業時間ではない)。
import type { TravelLeg } from '@tkb/contracts';
import { earliestOpenStart, fitsOpeningHours, parseOpeningHours, sequenceDay, validateSchedule, type TravelLookup } from '@tkb/planner';
import { describe, expect, it } from 'vitest';
import { act, day, leg, place } from './helpers.ts';

const codes = (r: { issues: { code: string }[] }) => r.issues.map(i => i.code);

describe('opening hours (架空)', () => {
  it('reads overnight and 24h ranges, and treats unreadable text as unknown (null), not open', () => {
    expect(parseOpeningHours('18:00-2:00')).toEqual([{ open: 1080, close: 1560 }]);
    expect(parseOpeningHours('24時間')).toEqual([{ open: 0, close: 2880 }]);
    expect(parseOpeningHours('月曜休 9:00-17:00')).toBeNull();
    expect(parseOpeningHours(null)).toBeNull();
  });

  it('a stay may cross midnight only inside an overnight range', () => {
    const night = parseOpeningHours('18:00-2:00')!;
    expect(fitsOpeningHours(night, 22 * 60, 25 * 60)).toBe(true);
    expect(fitsOpeningHours(night, 22 * 60, 27 * 60)).toBe(false);
    const day9 = parseOpeningHours('9:00-17:00')!;
    expect(fitsOpeningHours(day9, 16 * 60, 17 * 60 + 1)).toBe(false);
    expect(earliestOpenStart(day9, 7 * 60, 60)).toBe(9 * 60);
    expect(earliestOpenStart(day9, 16 * 60 + 30, 60)).toBeNull();
  });
});

describe('validateSchedule (架空)', () => {
  const places = [place('a', '9:00-17:00'), place('b', '9:00-17:00'), place('bar', '18:00-2:00')];

  it('flags a visit after closing (local time in the place zone) and unknown hours as a warning only', () => {
    const late = act('late', { placeId: 'a', start: '2026-07-01T08:00:00Z', end: '2026-07-01T09:00:00Z' }); // 17:00-18:00 JST
    expect(codes(validateSchedule({ days: [day([late])], places }))).toContain('outside_opening_hours');
    const unknown = validateSchedule({ days: [day([act('v', { placeId: 'n', start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z' })])], places: [place('n', null)] });
    expect(codes(unknown)).toContain('opening_hours_unknown');
    expect(unknown.feasible).toBe(true);
    expect(unknown.validationState).toBe('needs_review');
  });

  it('accepts an overnight stay at a late-night place that crosses midnight', () => {
    const bar = act('bar', { placeId: 'bar', start: '2026-07-01T13:00:00Z', end: '2026-07-01T16:00:00Z' }); // 22:00-01:00 JST
    expect(codes(validateSchedule({ days: [day([bar])], places }))).not.toContain('outside_opening_hours');
  });

  it('detects insufficient travel time and end before start', () => {
    const r = validateSchedule({
      days: [
        day([
          act('v1', { placeId: 'a', start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z' }),
          leg('ab', { from: 'a', to: 'b', dep: '2026-07-01T02:00:00Z', arr: '2026-07-01T02:30:00Z', sec: 1800 }),
          act('v2', { placeId: 'b', start: '2026-07-01T02:10:00Z', end: '2026-07-01T03:00:00Z' }),
        ]),
      ],
      places,
    });
    expect(r.feasible).toBe(false);
    expect(codes(r)).toEqual(expect.arrayContaining(['travel_time_insufficient']));
    const rev = validateSchedule({ days: [day([act('v', { placeId: 'a', start: '2026-07-01T02:00:00Z', end: '2026-07-01T01:00:00Z' })])], places });
    expect(codes(rev)).toContain('end_before_start');
  });

  it('multi-day: an activity crossing midnight and a leg ending on the next day are chronological, not an overlap', () => {
    const r = validateSchedule({
      days: [
        day([act('v1', { placeId: 'bar', start: '2026-07-01T13:00:00Z', end: '2026-07-01T16:00:00Z' }), leg('night', { from: 'bar', to: 'a', dep: '2026-07-01T16:00:00Z', arr: '2026-07-01T16:40:00Z', sec: 2400 })], '2026-07-01'),
        day([act('v2', { placeId: 'a', start: '2026-07-02T00:30:00Z', end: '2026-07-02T02:00:00Z' })], '2026-07-02'),
      ],
      places,
    });
    expect(codes(r)).not.toContain('overlap');
  });

  it('cross-zone day (Asia/Tokyo to Europe/Paris): opening hours use the place zone', () => {
    const paris = place('louvre_fake', '9:00-18:00', 'Europe/Paris');
    const ok = act('v', { placeId: 'louvre_fake', tz: 'Europe/Paris', start: '2026-07-02T07:00:00Z', end: '2026-07-02T09:00:00Z' }); // 09:00-11:00 CEST
    const bad = act('w', { placeId: 'louvre_fake', tz: 'Europe/Paris', start: '2026-07-02T00:00:00Z', end: '2026-07-02T01:00:00Z' }); // 02:00 CEST
    expect(codes(validateSchedule({ days: [day([ok], '2026-07-02', 'Europe/Paris')], places: [paris] }))).not.toContain('outside_opening_hours');
    expect(codes(validateSchedule({ days: [day([bad], '2026-07-02', 'Europe/Paris')], places: [paris] }))).toContain('outside_opening_hours');
  });

  it('fixed activity: a change or removal is a violation (R12)', () => {
    const fixed = act('res', { placeId: 'a', fixed: true, start: '2026-07-01T01:00:00Z', end: '2026-07-01T02:00:00Z' });
    const moved = { ...fixed, start: { utc: '2026-07-01T02:00:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T03:00:00Z', timeZone: 'Asia/Tokyo' } };
    expect(codes(validateSchedule({ days: [day([moved])], places, fixedActivities: [fixed] }))).toContain('fixed_activity_changed');
    expect(codes(validateSchedule({ days: [day([])], places, fixedActivities: [fixed] }))).toContain('fixed_activity_missing');
    expect(codes(validateSchedule({ days: [day([fixed])], places, fixedActivities: [fixed] }))).not.toContain('fixed_activity_changed');
  });

  it('unknown costs make the total a lower bound and are never counted as 0', () => {
    const r = validateSchedule({ days: [day([act('p', { placeId: 'a', cost: { amountMinor: 500, currency: 'JPY' } }), act('q', { placeId: 'a' })])], places });
    expect(r.hasUnknownCost).toBe(true);
    expect(r.totalKnownCost).toEqual([{ amountMinor: 500, currency: 'JPY' }]);
  });

  it('budget: unknown cost leaves the budget unverified instead of passing', () => {
    const r = validateSchedule({
      days: [day([act('q', { placeId: 'a' })])],
      places,
      constraints: { startDate: '2026-07-01', endDate: '2026-07-01', mustVisit: [], budget: { amountMinor: 1000, currency: 'JPY' } } as never,
    });
    expect(codes(r)).toContain('budget_unverified');
    expect(codes(r)).not.toContain('over_budget');
  });
});

describe('sequenceDay (架空)', () => {
  const places = [place('hotel'), place('a', '9:00-18:00'), place('b', '9:00-18:00'), place('stn'), place('far')];
  const base = { date: '2026-07-01', timeZone: 'Asia/Tokyo', dayStart: '09:00', dayEnd: '23:30', startPlaceId: 'hotel', places };
  const walk = (from: string, to: string, minutes: number): TravelLeg => ({ ...leg(`w_${from}_${to}`, { from, to, mode: 'walk', sec: minutes * 60 }), dataStatus: 'fixture' });
  const flat: TravelLookup = (from, to) => walk(from, to, 20);

  const startOf = (r: ReturnType<typeof sequenceDay>, id: string) => r.day.items.find(i => i.type === 'activity' && i.activityId === id);

  it('never moves a fixed/reserved activity, even when a flexible stop precedes it', () => {
    const fixed = act('res', { placeId: 'b', fixed: true, start: '2026-07-01T02:00:00Z', end: '2026-07-01T03:00:00Z' }); // 11:00-12:00
    const r = sequenceDay({
      ...base,
      stops: [{ activity: act('flex', { placeId: 'a' }), stayMinutes: 60 }, { activity: fixed }],
      travel: flat,
    });
    expect(startOf(r, 'res')).toMatchObject({ start: fixed.start, end: fixed.end });
    expect(r.validation.feasible).toBe(true);
  });

  it('a completed activity keeps its times too, and a skipped one is excluded as skipped', () => {
    const done = act('done', { placeId: 'a', status: 'completed', start: '2026-07-01T00:30:00Z', end: '2026-07-01T01:30:00Z' });
    const r = sequenceDay({ ...base, stops: [{ activity: done }, { activity: act('s', { placeId: 'b', status: 'skipped' }), stayMinutes: 30 }], travel: flat });
    expect(startOf(r, 'done')).toMatchObject({ start: done.start });
    expect(r.excluded).toEqual([{ activityId: 's', reason: 'skipped' }]);
  });

  it('fixed stop without times is excluded, not invented', () => {
    const r = sequenceDay({ ...base, stops: [{ activity: act('nt', { placeId: 'a', fixed: true }) }], travel: flat });
    expect(r.excluded).toEqual([{ activityId: 'nt', reason: 'fixed_time_unknown' }]);
  });

  it('unknown travel or unknown stay excludes the stop with a reason', () => {
    const r = sequenceDay({
      ...base,
      stops: [{ activity: act('x', { placeId: 'far' }), stayMinutes: 30 }, { activity: act('y', { placeId: 'a' }) }],
      travel: (f, t) => (t === 'far' ? null : walk(f, t, 10)),
    });
    expect(r.excluded).toEqual([{ activityId: 'x', reason: 'travel_unknown' }, { activityId: 'y', reason: 'stay_unknown' }]);
  });

  it('departure-time-dependent travel: the lookup gets the real departure instant and its leg is kept as returned', () => {
    const seen: string[] = [];
    const lookup: TravelLookup = (from, to, dep) => {
      seen.push(dep);
      const hour = Number(new Date(Date.parse(dep) + 9 * 3600_000).toISOString().slice(11, 13));
      return walk(from, to, hour >= 17 ? 45 : 15); // 架空: 夕方は混雑で遅い
    };
    const r = sequenceDay({ ...base, startPlaceId: 'a', stops: [{ activity: act('b1', { placeId: 'b' }), stayMinutes: 60 }], travel: lookup });
    expect(seen[0]).toBe('2026-07-01T00:00:00Z');
    expect(startOf(r, 'b1')).toMatchObject({ start: { utc: '2026-07-01T00:15:00Z' } });
  });

  it('after-22:00 departure with no route (架空の終電後): stop is excluded as travel_unknown, never given a made-up leg', () => {
    const lastTrain: TravelLookup = (from, to, dep) => {
      const local = new Date(Date.parse(dep) + 9 * 3600_000).toISOString().slice(11, 16);
      return local >= '22:00' ? null : walk(from, to, 20);
    };
    const night = act('night', { placeId: 'a', fixed: true, start: '2026-07-01T13:00:00Z', end: '2026-07-01T13:30:00Z' }); // 22:00-22:30 JST
    const r = sequenceDay({
      ...base,
      places: [...places, place('late_b', '23:00-23:59')],
      stops: [{ activity: night }, { activity: act('late', { placeId: 'late_b' }), stayMinutes: 30 }],
      travel: lastTrain,
    });
    expect(r.excluded).toEqual([{ activityId: 'late', reason: 'travel_unknown' }]);
    expect(r.day.items.some(i => i.type === 'activity' && i.activityId === 'late')).toBe(false);
  });

  it('stays inside opening hours: waits for opening and drops a stop that is closed by then', () => {
    const r = sequenceDay({
      ...base,
      places: [...places, place('late_open', '12:00-13:00')],
      stops: [{ activity: act('lo', { placeId: 'late_open' }), stayMinutes: 90 }, { activity: act('ok', { placeId: 'late_open' }), stayMinutes: 30 }],
      travel: flat,
    });
    expect(r.excluded).toEqual([{ activityId: 'lo', reason: expect.stringMatching(/closed|does_not_fit/) }]);
    expect(startOf(r, 'ok')).toMatchObject({ start: { utc: '2026-07-01T03:00:00Z' } }); // 12:00 JST
  });

  it('DST day in Europe/Paris: 09:00 start is exact and the day stays in order', () => {
    const r = sequenceDay({
      date: '2026-03-29',
      timeZone: 'Europe/Paris',
      dayStart: '09:00',
      dayEnd: '20:00',
      startPlaceId: null,
      places: [place('p', null, 'Europe/Paris')],
      stops: [{ activity: act('v', { placeId: 'p', tz: 'Europe/Paris' }), stayMinutes: 60 }],
      travel: flat,
    });
    expect(startOf(r, 'v')).toMatchObject({ start: { utc: '2026-03-29T07:00:00Z' } }); // 09:00 CEST (+2)
  });
});
