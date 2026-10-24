import type { Activity, TripDay } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { describe, expect, it } from 'vitest';
import { groupNearby, NEARBY_WALK_METERS } from './grouping.ts';
import { validateSchedule } from './validate.ts';

// #32 R4 acceptance on the Kanazawa fixture: undo the parent/child structure so the market area, the market walk and
// the sushi lunch next to it are three separate top-level items again, as the review found.
function flatKanazawaDay1(): TripDay {
  const day = structuredClone(domesticTrip.days[0]!);
  day.items = day.items.map(i => (i.type === 'activity' && i.parentActivityId ? { ...i, parentActivityId: null } : i));
  return day;
}
const acts = (d: TripDay) => d.items.filter((i): i is Activity => i.type === 'activity');
const byId = (d: TripDay, id: string) => acts(d).find(a => a.activityId === id)!;

describe('groupNearby (#32 R4)', () => {
  it('uses a 5-minute walk as the distance threshold', () => {
    expect(NEARBY_WALK_METERS).toBe(400);
  });

  it('turns the flattened market area, walk and lunch back into one parent with children', () => {
    const flat = flatKanazawaDay1();
    const r = groupNearby(flat, domesticTrip.places);
    const market = r.groups.find(g => g.parentActivityId === 'fx_act_omicho');
    expect(market?.childActivityIds).toEqual(expect.arrayContaining(['fx_act_omicho_walk', 'fx_act_lunch']));
    expect(byId(r.day, 'fx_act_lunch').parentActivityId).toBe('fx_act_omicho');
    // The fixed lunch keeps its own time; the result passes validation without children outside the parent.
    expect(byId(r.day, 'fx_act_lunch').start).toEqual(byId(flat, 'fx_act_lunch').start);
    const v = validateSchedule({ days: [r.day], places: domesticTrip.places });
    expect(v.issues.map(i => i.code)).not.toContain('child_outside_parent');
    expect(v.issues.map(i => i.code)).not.toContain('meal_after_meal');
  });

  it('widens a non-fixed parent to cover its children, drops legs inside the area, and leaves a fixed short parent alone', () => {
    const T = 'Asia/Tokyo';
    const at = (h: string) => ({ utc: `2026-11-01T${h}:00Z`, timeZone: T });
    const act = (id: string, placeId: string, s: string, e: string, extra: Partial<Activity> = {}): Activity => ({
      type: 'activity', activityId: id, kind: 'visit', title: id, placeId, areaName: null, start: at(s), end: at(e),
      fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null, ...extra,
    });
    const leg = { ...(domesticTrip.days[0]!.items.find(i => i.type === 'leg') as TripDay['items'][number] & { type: 'leg' }), legId: 'in', fromPlaceId: 'fx_omicho', toPlaceId: 'fx_sushi' };
    const day: TripDay = { date: '2026-11-01', timeZone: T, items: [act('area', 'fx_omicho', '02:00', '03:00', { kind: 'free_walk', areaName: '市場' }), leg, act('lunch', 'fx_sushi', '03:00', '04:00', { kind: 'meal' })] };
    const r = groupNearby(day, domesticTrip.places);
    expect(r.groups).toEqual([{ parentActivityId: 'area', childActivityIds: ['lunch'] }]);
    expect(byId(r.day, 'area').end?.utc).toBe('2026-11-01T04:00:00Z');
    expect(r.day.items.some(i => i.type === 'leg' && i.legId === 'in')).toBe(false);

    const fixedParent = { ...day, items: [{ ...day.items[0]!, fixed: true } as Activity, day.items[2]!] };
    const f = groupNearby(fixedParent, domesticTrip.places);
    expect(f.groups).toEqual([]);
    expect(f.skipped).toEqual([{ activityIds: ['area', 'lunch'], reason: 'fixed_parent_too_short' }]);
  });

  it('does not invent a parent when no area-level activity is in the run', () => {
    const T = 'Asia/Tokyo';
    const a = (id: string, placeId: string, h: string): Activity => ({
      type: 'activity', activityId: id, kind: 'visit', title: id, placeId, areaName: null, start: { utc: `2026-11-01T${h}:00:00Z`, timeZone: T },
      end: { utc: `2026-11-01T${h}:30:00Z`, timeZone: T }, fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null,
    });
    const r = groupNearby({ date: '2026-11-01', timeZone: T, items: [a('x', 'fx_kenrokuen', '01'), a('y', 'fx_21c_museum', '02')] }, domesticTrip.places);
    expect(r.groups).toEqual([]);
    expect(r.skipped[0]?.reason).toBe('no_area_activity');
  });
});

describe('meal_after_meal (#32 R4)', () => {
  it('warns when a meal is followed by another meal or a food walk, but not inside one area unit', () => {
    const flat = flatKanazawaDay1();
    // Put the sushi lunch right before the market food walk, as top-level items (the order the review found).
    const lunch = byId(flat, 'fx_act_lunch');
    const rest = flat.items.filter(i => !(i.type === 'activity' && i.activityId === 'fx_act_lunch'));
    const walkAt = rest.findIndex(i => i.type === 'activity' && i.activityId === 'fx_act_omicho_walk');
    const lunchFirst: TripDay = { ...flat, items: [...rest.slice(0, walkAt), lunch, ...rest.slice(walkAt)] };
    const found = validateSchedule({ days: [lunchFirst], places: domesticTrip.places }).issues.filter(i => i.code === 'meal_after_meal');
    expect(found.map(i => i.refs)).toContainEqual(['fx_act_lunch', 'fx_act_omicho_walk']);
    expect(found[0]).toMatchObject({ severity: 'warning' });
    // Grouping puts the lunch inside the market area: no warning any more.
    const grouped = groupNearby(lunchFirst, domesticTrip.places).day;
    expect(validateSchedule({ days: [grouped], places: domesticTrip.places }).issues.map(i => i.code)).not.toContain('meal_after_meal');
    // The fixture as shipped (lunch inside the market area) has no such warning.
    expect(validateSchedule({ days: domesticTrip.days, places: domesticTrip.places }).issues.map(i => i.code)).not.toContain('meal_after_meal');
  });
});
