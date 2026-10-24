// D06 verification on the B04 mock data: opening hours, travel time and must-visit contradictions are detected
// even though every place and leg is fixture data.
import type { Activity, TravelLeg, Trip } from '@tkb/contracts';
import { domesticTrip, overseasTrip } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { validateSchedule } from './validate.ts';

const check = (trip: Trip) =>
  validateSchedule({
    days: trip.days,
    places: trip.places,
    constraints: trip.constraints,
    fixedActivities: trip.days.flatMap(d => d.items).filter((i): i is Activity => i.type === 'activity' && i.fixed),
  });

const find = <T extends Activity | TravelLeg>(trip: Trip, id: string) =>
  trip.days.flatMap(d => d.items).find(i => (i.type === 'activity' ? i.activityId : i.legId) === id) as T;

describe('validateSchedule on B04 fixtures', () => {
  it('Kanazawa: feasible but needs review, listing every unknown instead of hiding it', () => {
    const r = check(domesticTrip);
    expect(r).toMatchObject({ feasible: true, validationState: 'needs_review', dataMode: 'fixture' });
    expect(r.issues.map(i => [i.code, i.refs[0]])).toEqual([
      ['travel_time_unknown', 'fx_leg_k1'],
      ['opening_hours_unknown', 'fx_act_castle'],
      ['opening_hours_unknown', 'fx_act_museum'],
      ['opening_hours_unknown', 'fx_act_dinner'],
      ['time_unknown', 'fx_act_hotel'],
      ['opening_hours_unknown', 'fx_act_oyama'],
      ['opening_hours_unknown', 'fx_act_nagamachi'],
      ['time_unknown', 'fx_act_station_end'],
      // Walk legs without a fare and activities without a cost are unknown costs too (D05 summarizeTripCosts), never 0.
      ['budget_unverified', 'fx_act_station'],
    ]);
  });

  it('Paris on the DST-end weekend: no false time conflicts (no item spans the switch itself)', () => {
    const r = check(overseasTrip);
    expect(r).toMatchObject({ feasible: true, validationState: 'needs_review' });
    expect(new Set(r.issues.map(i => i.code))).toEqual(new Set(['opening_hours_unknown']));
  });

  it('detects a visit outside the mock opening hours', () => {
    const trip = structuredClone(domesticTrip);
    const kenrokuen = find<Activity>(trip, 'fx_act_kenrokuen');
    // 17:30-19:00 JST, garden is open 7:00-18:00 in the fixture.
    kenrokuen.start = { utc: '2026-11-01T08:30:00Z', timeZone: 'Asia/Tokyo' };
    kenrokuen.end = { utc: '2026-11-01T10:00:00Z', timeZone: 'Asia/Tokyo' };
    trip.days[0]!.items = trip.days[0]!.items.filter(i => i.type === 'activity' && i.activityId === 'fx_act_kenrokuen');
    const r = check(trip);
    expect(r.feasible).toBe(false);
    expect(r.issues.filter(i => i.severity === 'violation').map(i => i.code)).toEqual(['outside_opening_hours']);
  });

  it('detects a mock travel time that does not fit', () => {
    const trip = structuredClone(domesticTrip);
    // The walk to the museum now takes 30 minutes but the visit still starts 15 minutes after leaving.
    Object.assign(find<TravelLeg>(trip, 'fx_leg_k4'), { arrival: null, durationSeconds: 1800 });
    const r = check(trip);
    expect(r.issues.filter(i => i.severity === 'violation')).toMatchObject([
      { code: 'travel_time_insufficient', refs: ['fx_leg_k4', 'fx_act_museum'], dayIndex: 0 },
    ]);
  });

  it('detects a dropped must-visit place and a moved reservation', () => {
    const trip = structuredClone(domesticTrip);
    const fixed = structuredClone(find<Activity>(domesticTrip, 'fx_act_lunch'));
    trip.days[0]!.items = trip.days[0]!.items.filter(i => i.type === 'activity' && i.activityId !== 'fx_act_kenrokuen');
    const lunch = find<Activity>(trip, 'fx_act_lunch');
    lunch.start = { utc: '2026-11-01T02:45:00Z', timeZone: 'Asia/Tokyo' };
    const r = validateSchedule({ days: trip.days, places: trip.places, constraints: trip.constraints, fixedActivities: [fixed] });
    expect(r.issues.filter(i => i.severity === 'violation').map(i => i.code)).toEqual(['must_visit_missing', 'fixed_activity_changed']);
  });
});

describe('validateSchedule: child activities (parentActivityId)', () => {
  it('a child inside its parent window adds no overlap; one outside it is a violation', () => {
    expect(check(domesticTrip).issues.some(i => i.code === 'overlap' || i.code === 'child_outside_parent')).toBe(false);
    const trip = structuredClone(domesticTrip);
    find<Activity>(trip, 'fx_act_lunch').end = { utc: '2026-11-01T04:00:00Z', timeZone: 'Asia/Tokyo' }; // 13:00, parent ends 12:30
    const r = check(trip);
    expect(r.issues.filter(i => i.severity === 'violation').map(i => i.code)).toEqual(['child_outside_parent']);
  });
});
