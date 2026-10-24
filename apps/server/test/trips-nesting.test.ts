// Activity.parentActivityId (U04 rework): one level of nesting, parent in the same day, no cycles, public allow-list.
import { describe, expect, it } from 'vitest';
import { Activity, PublicActivity, Trip, type TripOperation } from '@tkb/contracts';
import { applyOperations, nestingError } from '../src/trips/operations.ts';

const tz = 'Asia/Tokyo';
const act = (id: string, parent?: string | null) => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: null, areaName: null, start: null, end: null,
  fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: 'secret',
  ...(parent === undefined ? {} : { parentActivityId: parent }),
});
const trip = Trip.parse({
  schemaVersion: 1, tripId: 't1', ownerId: 'u', title: 'T', revision: 1,
  constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: tz, transportMode: 'transit' },
  days: [
    { date: '2026-11-01', timeZone: tz, items: [act('p1'), act('c1', 'p1'), act('p2')] },
    { date: '2026-11-02', timeZone: tz, items: [act('q1')] },
  ],
  places: [], validationState: 'valid', warnings: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
});
const run = (ops: TripOperation[]) => applyOperations(trip, ops);

describe('parentActivityId', () => {
  it('is optional and nullable in the schema; old data without it still parses', () => {
    expect(Activity.safeParse(act('a')).success).toBe(true);
    expect(Activity.safeParse(act('a', null)).success).toBe(true);
    expect(Activity.safeParse(act('a', 'p1')).success).toBe(true);
  });
  it('is part of the public allow-list while privateNotes still is not', () => {
    const pub = PublicActivity.parse(act('c1', 'p1'));
    expect(pub.parentActivityId).toBe('p1');
    expect('privateNotes' in pub).toBe(false);
  });
  it('accepts a child added under a parent of the same day', () => {
    expect(run([{ op: 'add', dayIndex: 0, position: 3, item: act('c2', 'p2') as never }]).ok).toBe(true);
  });
  it('rejects a parent that does not exist, is on another day, or whose child moved away', () => {
    expect(run([{ op: 'add', dayIndex: 0, position: 0, item: act('c2', 'nope') as never }]).ok).toBe(false);
    expect(run([{ op: 'add', dayIndex: 1, position: 0, item: act('c2', 'p1') as never }]).ok).toBe(false);
    expect(run([{ op: 'move', itemId: 'c1', toDayIndex: 1, toPosition: 0 }]).ok).toBe(false);
  });
  it('rejects removing a parent that still has children, but allows removing parent and child together', () => {
    expect(run([{ op: 'remove', itemId: 'p1' }]).ok).toBe(false);
    expect(run([{ op: 'remove', itemId: 'c1' }, { op: 'remove', itemId: 'p1' }]).ok).toBe(true);
  });
  it('rejects self-parent, cycles and grandchildren', () => {
    expect(run([{ op: 'update', itemId: 'p2', item: act('p2', 'p2') as never }]).ok).toBe(false);
    expect(run([{ op: 'update', itemId: 'p1', item: act('p1', 'c1') as never }]).ok).toBe(false);
    expect(run([{ op: 'add', dayIndex: 0, position: 0, item: act('g1', 'c1') as never }]).ok).toBe(false);
  });
  it('moving a parent with its children in one request is valid', () => {
    const r = run([
      { op: 'move', itemId: 'p1', toDayIndex: 0, toPosition: 2 },
      { op: 'move', itemId: 'c1', toDayIndex: 0, toPosition: 2 },
    ]);
    expect(r.ok).toBe(true);
  });
  it('nestingError is pure and reports null for a valid trip', () => {
    expect(nestingError(trip.days)).toBeNull();
  });
});
