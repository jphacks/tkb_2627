import type { Activity, PlaceInfo, TravelLeg } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { makeActivity, makeLeg } from '../time/fixtures.ts';
import { sequenceDay, type SequenceInput, type TravelLookup } from './sequence.ts';

const place = (placeId: string, openingHours: string | null = null, timeZone = 'Asia/Tokyo'): PlaceInfo => ({
  placeId,
  name: placeId,
  kind: 'spot',
  location: null,
  timeZone,
  openingHours,
  description: null,
  photo: null,
  dataStatus: 'fixture',
  provenance: { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null },
});

const stop = (id: string, placeId: string | null, extra: Partial<Activity> = {}): Activity => ({ ...makeActivity(id), placeId, ...extra });

/** Mock travel: a fixed duration per pair (either direction), unknown otherwise. */
const mockTravel = (minutes: Record<string, number>): TravelLookup => (from, to) => {
  const m = minutes[`${from}>${to}`] ?? minutes[`${to}>${from}`];
  return m === undefined ? null : { ...makeLeg(`leg_${from}_${to}`), mode: 'walk', fromPlaceId: from, toPlaceId: to, durationSeconds: m * 60, dataStatus: 'fixture' };
};

const base = (over: Partial<SequenceInput>): SequenceInput => ({
  date: '2026-07-01',
  timeZone: 'Asia/Tokyo',
  dayStart: '09:00',
  dayEnd: '20:00',
  startPlaceId: 'hotel',
  stops: [],
  places: [place('hotel'), place('garden', '9:00-17:00'), place('museum', '10:00-18:00'), place('sushi', '11:00-14:00'), place('cafe', null)],
  travel: mockTravel({ 'hotel>garden': 20, 'garden>museum': 15, 'museum>sushi': 10, 'garden>sushi': 25, 'hotel>museum': 30, 'sushi>cafe': 5 }),
  ...over,
});

const local = (utc: string | undefined) => (utc ? new Date(Date.parse(utc) + 9 * 3600_000).toISOString().slice(11, 16) : null);
const timeline = (r: ReturnType<typeof sequenceDay>) =>
  r.day.items.map(i => (i.type === 'activity' ? `${i.activityId} ${local(i.start?.utc)}-${local(i.end?.utc)}` : `→${i.toPlaceId}`));

describe('sequenceDay', () => {
  it('keeps the proposed order, adds travel and waits for opening hours', () => {
    const r = sequenceDay(
      base({
        stops: [
          { activity: stop('g', 'garden'), stayMinutes: 60 },
          { activity: stop('m', 'museum'), stayMinutes: 90 },
        ],
      }),
    );
    // Garden opens 9:00 but the walk takes 20 min; museum opens 10:00, reached 10:35.
    expect(timeline(r)).toEqual(['→garden', 'g 09:20-10:20', '→museum', 'm 10:35-12:05']);
    expect(r.excluded).toEqual([]);
    expect(r.validation).toMatchObject({ feasible: true });
  });

  it('never moves a fixed activity and moves a stop after it when it would make it late', () => {
    // Reservation 11:30-12:30 JST at the sushi place.
    const lunch = stop('lunch', 'sushi', { kind: 'meal', fixed: true, start: { utc: '2026-07-01T02:30:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T03:30:00Z', timeZone: 'Asia/Tokyo' } });
    const r = sequenceDay(
      base({
        stops: [
          { activity: stop('g', 'garden'), stayMinutes: 60 },
          { activity: stop('m', 'museum'), stayMinutes: 120 },
          { activity: lunch },
        ],
      }),
    );
    // Museum 10:35-12:35 would miss the 11:30 lunch, so it moves after lunch.
    expect(timeline(r)).toEqual(['→garden', 'g 09:20-10:20', '→sushi', 'lunch 11:30-12:30', '→museum', 'm 12:40-14:40']);
    expect(r.day.items.find(i => i.type === 'activity' && i.activityId === 'lunch')).toEqual(lunch);
    expect(r.validation.issues.filter(i => i.code.startsWith('fixed_'))).toEqual([]);
    expect(r.validation.feasible).toBe(true);
  });

  it('excludes stops that are closed, do not fit, have unknown travel or no stay, with the reason (R04)', () => {
    const r = sequenceDay(
      base({
        dayEnd: '13:00',
        stops: [
          { activity: stop('g', 'garden'), stayMinutes: 60 },
          { activity: stop('s', 'sushi'), stayMinutes: 240 }, // longer than the 11:00-14:00 opening
          { activity: stop('m', 'museum'), stayMinutes: 180 }, // 10:35-13:35 passes the day end
          { activity: stop('c', 'cafe'), stayMinutes: 30 }, // no travel known from the garden
          { activity: stop('x', 'museum') },
        ],
      }),
    );
    expect(timeline(r)).toEqual(['→garden', 'g 09:20-10:20']);
    expect(r.excluded).toEqual([
      { activityId: 's', reason: 'closed' },
      { activityId: 'm', reason: 'does_not_fit' },
      { activityId: 'c', reason: 'travel_unknown' },
      { activityId: 'x', reason: 'stay_unknown' },
    ]);
  });

  it('keeps an area-level free walk as its own item without a venue (R13)', () => {
    const walk = stop('walk', null, { kind: 'free_walk', areaName: '近江町市場周辺' });
    const r = sequenceDay(base({ startPlaceId: 'museum', stops: [{ activity: stop('s', 'sushi', { kind: 'meal' }), stayMinutes: 60 }, { activity: walk, stayMinutes: 45 }] }));
    expect(timeline(r)).toEqual(['→sushi', 's 11:00-12:00', 'walk 12:00-12:45']);
    expect(r.day.items.at(-1)).toMatchObject({ kind: 'free_walk', areaName: '近江町市場周辺', placeId: null });
    // Travel to an area without a place cannot be checked, so the result asks for review instead of claiming it fits.
    expect(r.validation).toMatchObject({ feasible: true, validationState: 'needs_review' });
    expect(r.validation.issues.map(i => i.code)).toContain('leg_missing');
  });

  it('reports a fixed activity that cannot be reached in time instead of hiding it (R03)', () => {
    const early = stop('early', 'sushi', { fixed: true, kind: 'meal', start: { utc: '2026-07-01T02:00:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T03:00:00Z', timeZone: 'Asia/Tokyo' } });
    const r = sequenceDay(base({ dayStart: '10:55', startPlaceId: 'garden', stops: [{ activity: early }] }));
    expect(timeline(r)).toEqual(['→sushi', 'early 11:00-12:00']);
    expect(r.validation).toMatchObject({ feasible: false, validationState: 'invalid' });
    expect(r.validation.issues.map(i => i.code)).toEqual(['travel_time_insufficient']);
  });

  it('keeps leg times exactly as the lookup returned them (no invented departure/arrival)', () => {
    const r = sequenceDay(base({ stops: [{ activity: stop('g', 'garden'), stayMinutes: 60 }] }));
    expect(r.day.items[0]).toMatchObject({ type: 'leg', departure: null, arrival: null, durationSeconds: 1200 });
  });

  it('excludes a fixed stop without times and reports it as a missing fixed activity', () => {
    const noTime = stop('res', 'sushi', { fixed: true, kind: 'meal' });
    const r = sequenceDay(base({ stops: [{ activity: noTime, stayMinutes: 60 }] }));
    expect(r.day.items).toEqual([]);
    expect(r.excluded).toEqual([{ activityId: 'res', reason: 'fixed_time_unknown' }]);
    expect(r.validation.issues.map(i => i.code)).toEqual(['fixed_activity_missing']);
  });

  it('flags unknown travel from the start place to the first fixed activity', () => {
    const lunch = stop('lunch', 'sushi', { kind: 'meal', fixed: true, start: { utc: '2026-07-01T02:30:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T03:30:00Z', timeZone: 'Asia/Tokyo' } });
    const r = sequenceDay(base({ travel: mockTravel({ 'hotel>museum': 10 }), stops: [{ activity: lunch }] }));
    expect(r.validation).toMatchObject({ feasible: true, validationState: 'needs_review' });
    expect(r.validation.issues.map(i => [i.code, i.refs])).toEqual([['leg_missing', ['hotel', 'lunch']]]);
  });

  it('waits for opening by wall clock on a DST change day (Paris 2026-10-25)', () => {
    const r = sequenceDay(
      base({
        date: '2026-10-25',
        timeZone: 'Europe/Paris',
        dayStart: '01:30',
        startPlaceId: 'hotel',
        places: [place('hotel', null, 'Europe/Paris'), place('mus', '9:00-18:00', 'Europe/Paris')],
        travel: mockTravel({ 'hotel>mus': 10 }),
        stops: [{ activity: stop('m', 'mus'), stayMinutes: 60 }],
      }),
    );
    // 9:00 CET is 08:00Z (CEST ended at 01:00Z).
    expect(r.day.items.at(-1)).toMatchObject({ start: { utc: '2026-10-25T08:00:00Z' }, end: { utc: '2026-10-25T09:00:00Z' } });
    expect(r.validation.feasible).toBe(true);
  });

  it('keeps a completed activity where it was, even when it is not fixed (R12)', () => {
    // Already visited 09:00-09:30 JST at the cafe (no opening hours, so nothing else would hold it at 09:00).
    const done = stop('done', 'cafe', { status: 'completed', start: { utc: '2026-07-01T00:00:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T00:30:00Z', timeZone: 'Asia/Tokyo' } });
    // Day window opens at 08:00: re-placing the visit would move it to 08:00-08:30.
    const r = sequenceDay(base({ dayStart: '08:00', startPlaceId: null, stops: [{ activity: done, stayMinutes: 30 }, { activity: stop('s', 'sushi'), stayMinutes: 60 }] }));
    expect(r.day.items.find(i => i.type === 'activity' && i.activityId === 'done')).toEqual(done);
    expect(timeline(r)).toEqual(['done 09:00-09:30', '→sushi', 's 11:00-12:00']);
    expect(r.validation.feasible).toBe(true);
  });

  it('does not place a skipped stop and reports it as excluded', () => {
    const gone = stop('gone', 'garden', { status: 'skipped', fixed: true, start: { utc: '2026-07-01T00:00:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-07-01T01:00:00Z', timeZone: 'Asia/Tokyo' } });
    const r = sequenceDay(base({ stops: [{ activity: gone, stayMinutes: 60 }, { activity: stop('m', 'museum'), stayMinutes: 60 }] }));
    expect(r.excluded).toEqual([{ activityId: 'gone', reason: 'skipped' }]);
    expect(timeline(r)).toEqual(['→museum', 'm 10:00-11:00']);
    expect(r.validation.issues.map(i => i.code)).not.toContain('fixed_activity_missing');
  });

  it('works on B04 mock places and is deterministic', () => {
    const fixtureLegs: TravelLeg[] = [
      { ...makeLeg('fx_l1'), fromPlaceId: 'fx_kanazawa_station', toPlaceId: 'fx_kenrokuen', durationSeconds: 1200, dataStatus: 'fixture' },
      { ...makeLeg('fx_l2'), fromPlaceId: 'fx_kenrokuen', toPlaceId: 'fx_21c_museum', mode: 'walk', durationSeconds: 900, dataStatus: 'fixture' },
    ];
    const travel: TravelLookup = (from, to) => fixtureLegs.find(l => l.fromPlaceId === from && l.toPlaceId === to) ?? null;
    const input = base({
      date: '2026-11-01',
      dayStart: '06:30',
      startPlaceId: 'fx_kanazawa_station',
      places: kanazawaPlaces,
      travel,
      stops: [
        { activity: stop('k', 'fx_kenrokuen'), stayMinutes: 90 },
        { activity: stop('m', 'fx_21c_museum'), stayMinutes: 60 },
      ],
    });
    const r = sequenceDay(input);
    // Garden opens 7:00 in the fixture; the museum has no hours, so the result needs review.
    expect(timeline(r)).toEqual(['→fx_kenrokuen', 'k 07:00-08:30', '→fx_21c_museum', 'm 08:45-09:45']);
    expect(r.validation).toMatchObject({ feasible: true, validationState: 'needs_review', dataMode: 'fixture' });
    expect(sequenceDay(input)).toEqual(r);
  });
});
