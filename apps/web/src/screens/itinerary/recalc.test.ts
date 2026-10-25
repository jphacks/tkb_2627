/** Undo and re-timing after a reorder (UI review on #33): nothing is guessed and the server applies the same result. */
import { describe, expect, it } from 'vitest';
import { Trip as TripSchema, type Activity, type TravelLeg, type Trip } from '@tkb/contracts';
import { domesticTrip } from '@tkb/fixtures';
import { applyOperations as applyServer } from '../../../../server/src/trips/operations.ts';
import { applyOperations as applyClient } from '../edit/ops.ts';
import { opsToDay, recalcDay } from './recalc.ts';
import { blockOf, hoverTarget, planMoves, previewRows, tableRows } from './table.ts';

const ids = (t: Trip, d = 0) => t.days[d]!.items.map(i => (i.type === 'activity' ? i.activityId : i.legId));
const act = (t: Trip, id: string) => t.days[0]!.items.find(i => i.type === 'activity' && i.activityId === id) as Activity;
const legs = (t: Trip) => t.days[0]!.items.filter((i): i is TravelLeg => i.type === 'leg');

function moved(): Trip {
  const day = domesticTrip.days[0]!;
  const r = applyClient(domesticTrip, planMoves(ids(domesticTrip), blockOf(day, 'fx_act_museum'), 'fx_act_castle', 0));
  if (!r.ok) throw new Error(r.reason);
  return r.trip;
}

describe('recalcDay', () => {
  it('without a reorder nothing changes (untouched pairs keep their legs and gaps)', () => {
    const r = recalcDay(domesticTrip, 0);
    expect(r.trip.days[0]).toEqual(domesticTrip.days[0]);
    expect(r.unknown).toBe(0);
  });

  it('after a reorder the stale legs are replaced; a new pair with no known leg leaves the later times unknown', () => {
    const r = recalcDay(moved(), 0);
    expect(TripSchema.safeParse(r.trip).success).toBe(true);
    expect(r.trip.validationState).toBe('needs_revalidation');
    const ls = legs(r.trip);
    // every leg now joins the stays around it
    const rows = tableRows(r.trip.days[0]!, r.trip.places);
    expect(rows.some(x => x.kind === 'leg' && x.stale)).toBe(false);
    expect(r.unknown).toBeGreaterThan(0);
    const unknownLeg = ls.find(l => l.dataStatus === 'unknown' && l.legId.startsWith('leg_rc0'))!;
    expect(unknownLeg.durationSeconds).toBeNull();
    expect(unknownLeg.fare).toBeNull();
    expect(unknownLeg.arrival).toBeNull();
    // stays before the change keep their times; the moved stay follows the omicho block
    expect(act(r.trip, 'fx_act_omicho').start).toEqual(act(domesticTrip, 'fx_act_omicho').start);
    expect(act(r.trip, 'fx_act_lunch')).toEqual(act(domesticTrip, 'fx_act_lunch')); // fixed child keeps its time
    expect(act(r.trip, 'fx_act_hotel').start).toBeNull(); // after an unknown leg: 未取得, never a guess
  });
});

describe('opsToDay (saving undo / re-timing through K10)', () => {
  it('the server turns the reordered day back into the original (undo)', () => {
    const m = moved();
    const ops = opsToDay(m.days[0]!, domesticTrip.days[0]!, 0);
    const r = applyServer(m, ops);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trip.days[0]!.items).toEqual(domesticTrip.days[0]!.items);
  });

  it('the server saves the re-timed day as computed', () => {
    const m = moved();
    const next = recalcDay(m, 0).trip;
    const r = applyServer(m, opsToDay(m.days[0]!, next.days[0]!, 0));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.trip.days[0]!.items).toEqual(next.days[0]!.items);
  });

  it('no change gives no operations', () => {
    expect(opsToDay(domesticTrip.days[0]!, domesticTrip.days[0]!, 0)).toEqual([]);
  });
});

describe('live order while dragging', () => {
  const rows = tableRows(domesticTrip.days[0]!, domesticTrip.places);
  const stays = rows.flatMap(r => (r.kind === 'stay' ? [r.key] : []));
  it('each stay moves with the legs after it', () => {
    const order = [stays[1]!, stays[0]!, ...stays.slice(2)];
    const shown = previewRows(rows, order).map(r => r.key);
    expect(shown.slice(0, 2)).toEqual(['fx_act_omicho', 'fx_leg_k2']);
    expect(shown.slice(2, 4)).toEqual(['fx_act_station', 'fx_leg_k1']);
    expect(shown).toHaveLength(rows.length);
  });
  it('hovering reads the order on screen; back over the start gives no move', () => {
    expect(hoverTarget(stays, stays, 'fx_act_station', 'fx_act_omicho', true)).toBe('fx_act_castle');
    const shown = ['fx_act_omicho', 'fx_act_station', ...stays.slice(2)];
    expect(hoverTarget(stays, shown, 'fx_act_station', 'fx_act_omicho', false)).toBeUndefined();
  });
});
