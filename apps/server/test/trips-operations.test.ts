import { describe, expect, it } from 'vitest';
import { Trip, type TripOperation } from '@tkb/contracts';
import { applyOperations, computeDiff } from '../src/trips/operations.ts';

const tz = 'Asia/Tokyo';
const act = (id: string, h: number, cost: number | null) => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: null, areaName: null,
  start: { utc: `2026-11-01T0${h}:00:00Z`, timeZone: tz }, end: { utc: `2026-11-01T0${h + 1}:00:00Z`, timeZone: tz },
  fixed: false, status: 'planned', cost: cost === null ? null : { amountMinor: cost, currency: 'JPY' },
  costStatus: cost === null ? 'unknown' : 'fixture', privateNotes: null,
});
const trip = Trip.parse({
  schemaVersion: 1, tripId: 't1', ownerId: 'u', title: 'T', revision: 1,
  constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: tz, transportMode: 'transit' },
  days: [
    { date: '2026-11-01', timeZone: tz, items: [act('a1', 1, 500), act('a2', 3, null)] },
    { date: '2026-11-02', timeZone: tz, items: [] },
  ],
  places: [], validationState: 'valid', warnings: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});
const ids = (t: Trip) => t.days.map((d) => d.items.map((i) => (i.type === 'activity' ? i.activityId : i.legId)));
const run = (ops: TripOperation[]) => applyOperations(trip, ops);

describe('applyOperations', () => {
  it('set_title keeps validation state; structural edits need revalidation; input not mutated', () => {
    const t = run([{ op: 'set_title', title: 'New' }]);
    expect(t.ok && t.trip.title).toBe('New');
    expect(t.ok && t.trip.validationState).toBe('valid');
    const r = run([{ op: 'remove', itemId: 'a1' }]);
    expect(r.ok && ids(r.trip)).toEqual([['a2'], []]);
    expect(r.ok && r.trip.validationState).toBe('needs_revalidation');
    expect(ids(trip)).toEqual([['a1', 'a2'], []]);
  });
  it('move across days and add/update', () => {
    const m = run([{ op: 'move', itemId: 'a1', toDayIndex: 1, toPosition: 0 }]);
    expect(m.ok && ids(m.trip)).toEqual([['a2'], ['a1']]);
    const add = run([{ op: 'add', dayIndex: 1, position: 0, item: act('a3', 5, 100) as never }]);
    expect(add.ok && ids(add.trip)).toEqual([['a1', 'a2'], ['a3']]);
    const up = run([{ op: 'update', itemId: 'a2', item: act('a2', 4, 900) as never }]);
    expect(up.ok && up.trip.days[0]!.items[1]).toMatchObject({ cost: { amountMinor: 900, currency: 'JPY' } });
  });
  it('rejects unknown ids, bad indexes, duplicates and id changes, reporting the operation index', () => {
    expect(run([{ op: 'set_title', title: 'ok' }, { op: 'remove', itemId: 'nope' }])).toEqual({ ok: false, index: 1, reason: 'unknown itemId' });
    expect(run([{ op: 'add', dayIndex: 9, position: 0, item: act('a3', 5, 1) as never }]).ok).toBe(false);
    expect(run([{ op: 'add', dayIndex: 0, position: 5, item: act('a3', 5, 1) as never }]).ok).toBe(false);
    expect(run([{ op: 'add', dayIndex: 0, position: 0, item: act('a1', 5, 1) as never }]).ok).toBe(false);
    expect(run([{ op: 'update', itemId: 'a1', item: act('zz', 5, 1) as never }]).ok).toBe(false);
    expect(run([{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 9 }]).ok).toBe(false);
  });
});

describe('computeDiff', () => {
  it('known cost delta ignores unknown cost and lists it separately', () => {
    const after = applyOperations(trip, [{ op: 'remove', itemId: 'a1' }]);
    if (!after.ok) throw new Error('x');
    const d = computeDiff(trip, after.trip);
    expect(d.knownCostDelta).toEqual([{ amountMinor: -500, currency: 'JPY' }]);
    expect(d.unknownCostItems).toEqual(['a2']);
    expect(d.durationDeltaSeconds).toBe(-7200);
  });
  it('duration delta is null when nothing is timed, and no cost change gives empty delta', () => {
    const d = computeDiff(trip, trip);
    expect(d.knownCostDelta).toEqual([]);
    expect(d.durationDeltaSeconds).toBe(0);
    const bare = { ...trip, days: [{ ...trip.days[0]!, items: [] }] };
    expect(computeDiff(bare, bare).durationDeltaSeconds).toBeNull();
  });
});
