import type { Activity, PlaceInfo, TravelLeg } from '@tkb/contracts';
import { describe, expect, it } from 'vitest';
import { makeActivity, makeDay, makeLeg } from '../time/fixtures.ts';
import { validateSchedule, type ScheduleIssueCode, type ScheduleValidation } from './validate.ts';

const place = (placeId: string, openingHours: string | null = '9:00-18:00', extra: Partial<PlaceInfo> = {}): PlaceInfo => ({
  placeId,
  name: placeId,
  kind: 'spot',
  location: null,
  timeZone: 'Asia/Tokyo',
  openingHours,
  description: null,
  photo: null,
  dataStatus: 'fixture',
  provenance: { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null },
  ...extra,
});
const places = [place('a'), place('b'), place('c')];

// Times are UTC; Asia/Tokyo is +9, so 01:00Z is 10:00 local.
const visit = (id: string, placeId: string | null, start: string | null, end: string | null, extra: Partial<Activity> = {}): Activity => ({
  ...makeActivity(id, { start, end }),
  placeId,
  ...extra,
});
const leg = (id: string, from: string, to: string, departure: string | null, arrival: string | null, extra: Partial<TravelLeg> = {}): TravelLeg => ({
  ...makeLeg(id, { departure, arrival }),
  fromPlaceId: from,
  toPlaceId: to,
  ...extra,
});

const codes = (r: ScheduleValidation) => r.issues.map(i => i.code);
const only = (r: ScheduleValidation, code: ScheduleIssueCode) => r.issues.filter(i => i.code === code);

const good = () =>
  makeDay([
    visit('va', 'a', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
    leg('ab', 'a', 'b', '2026-07-01T02:00:00Z', '2026-07-01T02:30:00Z', { durationSeconds: 1800 }),
    visit('vb', 'b', '2026-07-01T02:30:00Z', '2026-07-01T04:00:00Z'),
  ]);

describe('validateSchedule', () => {
  it('accepts a consistent day with known data as valid', () => {
    const r = validateSchedule({ days: [good()], places, constraints: { startDate: '2026-07-01', endDate: '2026-07-01', mustVisit: ['a'] } });
    expect(r).toMatchObject({ feasible: true, validationState: 'valid', issues: [], dataMode: 'fixture' });
  });

  it('detects travel that does not fit between activities (leg times, duration only, or arrival after the next start)', () => {
    const byArrival = good();
    byArrival.items[1] = leg('ab', 'a', 'b', '2026-07-01T02:00:00Z', '2026-07-01T02:45:00Z');
    expect(codes(validateSchedule({ days: [byArrival], places }))).toEqual(['travel_time_insufficient']);

    const byDuration = good();
    byDuration.items[1] = leg('ab', 'a', 'b', null, null, { durationSeconds: 3600 });
    const r = validateSchedule({ days: [byDuration], places });
    expect(r.feasible).toBe(false);
    expect(only(r, 'travel_time_insufficient')[0]).toMatchObject({ severity: 'violation', refs: ['ab', 'vb'], dayIndex: 0 });

    const arrivalOnly = good();
    arrivalOnly.items[1] = leg('ab', 'a', 'b', null, '2026-07-01T02:30:00Z', { durationSeconds: 3600 });
    expect(codes(validateSchedule({ days: [arrivalOnly], places }))).toEqual(['travel_time_insufficient']);

    // Arrival only, duration unknown: arriving at b before leaving a is still certain to fail.
    const arrivesEarly = good();
    arrivesEarly.items[1] = leg('ab', 'a', 'b', null, '2026-07-01T01:30:00Z');
    expect(validateSchedule({ days: [arrivesEarly], places }).feasible).toBe(false);
  });

  it('checks travel from the day start place and time to the first item', () => {
    const lunch = visit('lunch', 'b', '2026-07-01T02:00:00Z', '2026-07-01T03:00:00Z', { kind: 'meal' });
    const toLunch = leg('ab', 'a', 'b', null, null, { durationSeconds: 1800 });
    const start = { placeId: 'a', time: { utc: '2026-07-01T01:45:00Z', timeZone: 'Asia/Tokyo' } };
    expect(codes(validateSchedule({ days: [makeDay([toLunch, lunch])], places, dayStarts: [start] }))).toEqual(['travel_time_insufficient']);
    expect(codes(validateSchedule({ days: [makeDay([lunch])], places, dayStarts: [start] }))).toEqual(['leg_missing']);
    expect(validateSchedule({ days: [makeDay([lunch])], places, dayStarts: [{ placeId: 'b', time: null }] }).issues).toEqual([]);
  });

  it('reports overlapping activities and an end before the start', () => {
    const day = makeDay([
      visit('va', 'a', '2026-07-01T01:00:00Z', '2026-07-01T03:00:00Z'),
      visit('va2', 'a', '2026-07-01T02:00:00Z', '2026-07-01T01:30:00Z'),
    ]);
    expect(codes(validateSchedule({ days: [day], places }))).toEqual(['end_before_start', 'overlap']);

    // Only the end is known, but it is before the previous activity ends.
    const endOnly = makeDay([visit('va', 'a', '2026-07-01T01:00:00Z', '2026-07-01T03:00:00Z'), visit('vb', 'a', null, '2026-07-01T02:00:00Z')]);
    expect(codes(validateSchedule({ days: [endOnly], places }))).toEqual(['time_unknown', 'overlap']);
  });

  it('checks opening hours in the place time zone, including stays past midnight', () => {
    const late = makeDay([visit('va', 'a', '2026-07-01T08:30:00Z', '2026-07-01T09:30:00Z')]); // 17:30-18:30
    const r = validateSchedule({ days: [late], places });
    expect(only(r, 'outside_opening_hours')[0]).toMatchObject({ refs: ['va', 'a'], severity: 'violation' });

    const bar = [place('bar', '18:00-2:00')];
    const night = makeDay([visit('vbar', 'bar', '2026-07-01T14:00:00Z', '2026-07-01T16:30:00Z')]); // 23:00-1:30
    expect(validateSchedule({ days: [night], places: bar }).issues).toEqual([]);
    const tooLate = makeDay([visit('vbar', 'bar', '2026-07-01T14:00:00Z', '2026-07-01T17:30:00Z')]); // until 2:30
    expect(codes(validateSchedule({ days: [tooLate], places: bar }))).toEqual(['outside_opening_hours']);

    // Paris place in a Tokyo-labelled day: 14:00-15:00 CEST (12:00Z) is open in Paris; read in Tokyo it would be 21:00.
    const paris = [place('louvre', '9:00-18:00', { timeZone: 'Europe/Paris' })];
    const visitParis = makeDay([visit('vl', 'louvre', '2026-07-01T12:00:00Z', '2026-07-01T13:00:00Z')]);
    expect(validateSchedule({ days: [visitParis], places: paris }).issues).toEqual([]);

    // 2026-10-25, after DST ends in Paris: 08:00Z is 9:00 CET (open), 07:30Z is 8:30 CET (closed).
    const dst = (start: string, end: string) => makeDay([visit('vl', 'louvre', start, end)], 'Europe/Paris', '2026-10-25');
    expect(validateSchedule({ days: [dst('2026-10-25T08:00:00Z', '2026-10-25T09:00:00Z')], places: paris }).issues).toEqual([]);
    expect(codes(validateSchedule({ days: [dst('2026-10-25T07:30:00Z', '2026-10-25T09:00:00Z')], places: paris }))).toEqual(['outside_opening_hours']);
  });

  it('treats unreadable or missing hours as a warning for venues but not for open areas', () => {
    const p = [place('museum', null), place('area', null, { kind: 'area' }), place('market', '月曜定休', { kind: 'area' })];
    const day = makeDay([
      visit('vm', 'museum', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
      visit('vw', 'area', '2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z', { kind: 'free_walk', areaName: 'エリア' }),
      visit('vk', 'market', '2026-07-01T05:00:00Z', '2026-07-01T06:00:00Z', { kind: 'free_walk', areaName: '市場' }),
    ]);
    const r = validateSchedule({ days: [day], places: p });
    expect(only(r, 'opening_hours_unknown').map(i => i.refs[0])).toEqual(['vm', 'vk']);
    expect(r).toMatchObject({ feasible: true, validationState: 'needs_review' });

    // A visit without a place cannot have its hours checked either.
    const nowhere = makeDay([visit('vx', null, '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z')]);
    expect(codes(validateSchedule({ days: [nowhere], places }))).toEqual(['opening_hours_unknown']);
  });

  it('reports a missing must-visit place, and does not count a skipped visit', () => {
    const day = good();
    day.items[0] = { ...(day.items[0] as Activity), status: 'skipped' };
    const r = validateSchedule({ days: [day], places, constraints: { startDate: '2026-07-01', endDate: '2026-07-01', mustVisit: ['a', 'c'] } });
    expect(only(r, 'must_visit_missing').map(i => i.refs)).toEqual([['a'], ['c']]);
    expect(r.validationState).toBe('invalid');
  });

  it('checks leg endpoints against neighbouring activities and warns when travel between places is missing', () => {
    const wrong = good();
    wrong.items[1] = leg('ab', 'c', 'c', '2026-07-01T02:00:00Z', '2026-07-01T02:30:00Z');
    expect(codes(validateSchedule({ days: [wrong], places }))).toEqual(['leg_endpoint_mismatch', 'leg_endpoint_mismatch']);

    const gap = makeDay([good().items[0]!, good().items[2]!]);
    expect(only(validateSchedule({ days: [gap], places }), 'leg_missing')[0]).toMatchObject({ severity: 'warning', refs: ['va', 'vb'] });

    // Next day starts fresh: no travel is required from the last place of the previous day.
    const day2 = makeDay([visit('vc', 'c', '2026-07-02T01:00:00Z', '2026-07-02T02:00:00Z')], 'Asia/Tokyo', '2026-07-02');
    expect(validateSchedule({ days: [good(), day2], places }).issues).toEqual([]);
  });

  it('warns about unknown times and travel durations instead of treating them as fine', () => {
    const day = makeDay([
      visit('va', 'a', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
      leg('ab', 'a', 'b', '2026-07-01T02:00:00Z', null),
      visit('vb', 'b', null, null),
    ]);
    const r = validateSchedule({ days: [day], places });
    expect(codes(r)).toEqual(['travel_time_unknown', 'time_unknown']);
    expect(r.validationState).toBe('needs_review');
  });

  it('rejects place IDs that were not provided and R13 kind mismatches', () => {
    const day = makeDay([
      visit('vx', 'nowhere', '2026-07-01T01:00:00Z', '2026-07-01T02:00:00Z'),
      visit('meal', null, '2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z', { kind: 'meal' }),
      visit('walk', null, '2026-07-01T05:00:00Z', '2026-07-01T06:00:00Z', { kind: 'free_walk' }),
    ]);
    const r = validateSchedule({ days: [day], places });
    expect(r.issues.filter(i => i.severity === 'violation').map(i => i.code)).toEqual(['unknown_place', 'meal_without_place', 'free_walk_without_area']);
  });

  it('keeps fixed activities: missing or moved ones are violations', () => {
    const fixed = visit('lunch', 'b', '2026-07-01T03:00:00Z', '2026-07-01T04:00:00Z', { kind: 'meal', fixed: true });
    const kept = makeDay([fixed]);
    expect(validateSchedule({ days: [kept], places, fixedActivities: [fixed] }).issues).toEqual([]);

    const moved = makeDay([{ ...fixed, start: { utc: '2026-07-01T03:30:00Z', timeZone: 'Asia/Tokyo' } }]);
    expect(codes(validateSchedule({ days: [moved], places, fixedActivities: [fixed] }))).toEqual(['fixed_activity_changed']);
    expect(codes(validateSchedule({ days: [good()], places, fixedActivities: [fixed] }))).toEqual(['fixed_activity_missing']);

    // The same instant written differently is not a change.
    const sameInstant = makeDay([{ ...fixed, start: { timeZone: 'Asia/Tokyo', utc: '2026-07-01T03:00:00.000Z' } }]);
    expect(validateSchedule({ days: [sameInstant], places, fixedActivities: [fixed] }).issues).toEqual([]);
  });

  it('warns, without failing the plan, when a fixed activity was skipped (R12)', () => {
    const day = good();
    day.items[2] = { ...(day.items[2] as Activity), fixed: true, status: 'skipped' };
    const r = validateSchedule({ days: [day], places });
    expect(r.issues.map(i => [i.code, i.severity, i.refs])).toEqual([['fixed_activity_skipped', 'warning', ['vb']]]);
    expect(r).toMatchObject({ feasible: true, validationState: 'needs_review' });
  });

  it('checks trip dates in the day time zone', () => {
    const r = validateSchedule({ days: [good()], places, constraints: { startDate: '2026-07-02', endDate: '2026-07-03' } });
    expect(new Set(codes(r))).toEqual(new Set(['outside_trip_dates']));

    // 15:30Z on 07-01 is 00:30 on 07-02 in Tokyo: inside the trip but on the wrong day.
    const late = makeDay([visit('va', 'a', '2026-07-01T15:30:00Z', '2026-07-01T16:00:00Z')]);
    const r2 = validateSchedule({ days: [late], places: [place('a', '24時間')], constraints: { startDate: '2026-07-01', endDate: '2026-07-02' } });
    expect(codes(r2)).toEqual(['day_mismatch']);
  });

  it('compares the budget with known costs only and never counts unknown costs as 0 (R11)', () => {
    const jpy = (amountMinor: number) => ({ amountMinor, currency: 'JPY' });
    const day = good();
    day.items[0] = { ...(day.items[0] as Activity), cost: jpy(3000), costStatus: 'fixture' };
    day.items[2] = { ...(day.items[2] as Activity), cost: jpy(1500), costStatus: 'fixture' };
    day.items[1] = { ...(day.items[1] as TravelLeg), fare: jpy(200) };
    const c = (amount: number) => ({ startDate: '2026-07-01', endDate: '2026-07-01', budget: jpy(amount) });

    const ok = validateSchedule({ days: [day], places, constraints: c(5000) });
    expect(ok).toMatchObject({ issues: [], totalKnownCost: [jpy(4700)], hasUnknownCost: false });
    expect(codes(validateSchedule({ days: [day], places, constraints: c(4000) }))).toEqual(['over_budget']);

    day.items[1] = { ...(day.items[1] as TravelLeg), fare: null };
    const r = validateSchedule({ days: [day], places, constraints: c(5000) });
    expect(only(r, 'budget_unverified')[0]).toMatchObject({ severity: 'warning', refs: ['ab'] });
    expect(r).toMatchObject({ totalKnownCost: [jpy(4500)], hasUnknownCost: true });

    day.items[2] = { ...(day.items[2] as Activity), cost: { amountMinor: 1000, currency: 'EUR' } };
    day.items[1] = { ...(day.items[1] as TravelLeg), fare: jpy(200) };
    expect(only(validateSchedule({ days: [day], places, constraints: c(5000) }), 'budget_unverified')[0]!.message).toContain('EUR');
  });

  it('labels the data mode from the places and legs used', () => {
    const live = places.map(p => ({ ...p, dataStatus: 'verified' as const }));
    const day = good();
    day.items[1] = { ...(day.items[1] as TravelLeg), dataStatus: 'verified' };
    expect(validateSchedule({ days: [day], places: live }).dataMode).toBe('live');
    day.items[1] = { ...(day.items[1] as TravelLeg), dataStatus: 'fixture' };
    expect(validateSchedule({ days: [day], places: live }).dataMode).toBe('mixed');
    // An unknown leg (makeLeg without fare) is neither fixture nor live.
    expect(validateSchedule({ days: [good()], places: live }).dataMode).toBe('live');
    expect(validateSchedule({ days: [], places }).dataMode).toBeNull();
  });

  it('is deterministic', () => {
    const input = { days: [good()], places, constraints: { startDate: '2026-07-01', endDate: '2026-07-01', mustVisit: ['c'] } };
    expect(validateSchedule(input)).toEqual(validateSchedule(structuredClone(input)));
  });
});
