import { describe, expect, it } from 'vitest';
import { Trip, type TripOperation } from '@tkb/contracts';
import { applyOperations, computeDiff } from '../src/trips/operations.ts';

const tz = 'Asia/Tokyo';
const act = (id: string, h: number | null, cost: number | null, currency = 'JPY') => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: null, areaName: null,
  start: h === null ? null : { utc: `2026-11-01T0${h}:00:00Z`, timeZone: tz }, end: h === null ? null : { utc: `2026-11-01T0${h + 1}:00:00Z`, timeZone: tz },
  fixed: false, status: 'planned', cost: cost === null ? null : { amountMinor: cost, currency },
  costStatus: cost === null ? 'unknown' : 'fixture', privateNotes: null,
});
const leg = (id: string, mode: 'transit' | 'car' | 'walk', fare: number | null, currency = 'JPY') => ({
  type: 'leg', legId: id, mode, fromPlaceId: 'p', toPlaceId: 'q', departure: null, arrival: null, durationSeconds: null,
  lineName: null, platform: null, transfers: null, fare: fare === null ? null : { amountMinor: fare, currency }, dataStatus: 'fixture', provenance: null,
});
const mk = (days: unknown[][], state = 'valid') =>
  Trip.parse({
    schemaVersion: 1, tripId: 't1', ownerId: 'u', title: 'T', revision: 1,
    constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-03', timeZone: tz, transportMode: 'transit' },
    days: days.map((items, i) => ({ date: `2026-11-0${i + 1}`, timeZone: tz, items })),
    places: [], validationState: state, warnings: [], createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  });
const ids = (t: Trip) => t.days.map((d) => d.items.map((i) => (i.type === 'activity' ? i.activityId : i.legId)));
const ok = (r: ReturnType<typeof applyOperations>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.trip;
};

describe('applyOperations edge cases', () => {
  const t = () => mk([[act('a', 1, 1), act('b', 3, 2), act('c', 5, 3)], [act('d', 1, 4)], []]);
  it('move to the same index is a no-op on order', () => {
    expect(ids(ok(applyOperations(t(), [{ op: 'move', itemId: 'b', toDayIndex: 0, toPosition: 1 }])))).toEqual([['a', 'b', 'c'], ['d'], []]);
  });
  it('move forward within a day uses post-removal positions', () => {
    expect(ids(ok(applyOperations(t(), [{ op: 'move', itemId: 'a', toDayIndex: 0, toPosition: 2 }])))[0]).toEqual(['b', 'c', 'a']);
    expect(applyOperations(t(), [{ op: 'move', itemId: 'a', toDayIndex: 0, toPosition: 3 }]).ok).toBe(false);
  });
  it('failed move does not lose the item (input untouched, nothing returned)', () => {
    const before = t();
    const snapshot = JSON.stringify(before);
    const r = applyOperations(before, [{ op: 'move', itemId: 'a', toDayIndex: 1, toPosition: 9 }]);
    expect(r).toMatchObject({ ok: false, index: 0 });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
  it('remove the last item of a day keeps the (empty) day; removing everything keeps day count', () => {
    const r = ok(applyOperations(t(), [{ op: 'remove', itemId: 'd' }]));
    expect(ids(r)).toEqual([['a', 'b', 'c'], [], []]);
    const all = ok(applyOperations(t(), ['a', 'b', 'c', 'd'].map((itemId) => ({ op: 'remove', itemId }) as TripOperation)));
    expect(ids(all)).toEqual([[], [], []]);
    expect(all.days.map((d) => d.date)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });
  it('ops apply sequentially: add then move the added item, remove then re-add same id', () => {
    const r = ok(applyOperations(t(), [
      { op: 'add', dayIndex: 2, position: 0, item: act('e', 2, 9) as never },
      { op: 'move', itemId: 'e', toDayIndex: 0, toPosition: 0 },
      { op: 'remove', itemId: 'a' },
      { op: 'add', dayIndex: 1, position: 1, item: act('a', 1, 1) as never },
    ]));
    expect(ids(r)).toEqual([['e', 'b', 'c'], ['d', 'a'], []]);
  });
  it('update cannot change id or type; leg id namespace is shared with activity ids', () => {
    const tt = mk([[act('a', 1, 1), leg('l', 'transit', 100)]]);
    expect(applyOperations(tt, [{ op: 'update', itemId: 'a', item: act('b', 1, 1) as never }])).toMatchObject({ ok: false, index: 0 });
    expect(applyOperations(tt, [{ op: 'update', itemId: 'a', item: leg('a', 'walk', null) as never }])).toMatchObject({ ok: false });
    expect(applyOperations(tt, [{ op: 'update', itemId: 'l', item: act('l', 1, 1) as never }])).toMatchObject({ ok: false });
    expect(applyOperations(tt, [{ op: 'add', dayIndex: 0, position: 0, item: act('l', 1, 1) as never }])).toMatchObject({ ok: false });
  });
  it('unknown op at runtime does not silently succeed with a structural change', () => {
    const r = applyOperations(t(), [{ op: 'explode' } as never]);
    if (r.ok) expect(r.trip).toEqual({ ...t() }); // tolerated only if it is a pure no-op
  });
  it('validation state: set_title keeps every state; structural edit forces needs_revalidation (even from invalid/needs_review)', () => {
    for (const s of ['valid', 'needs_review', 'needs_revalidation', 'invalid']) {
      const base = mk([[act('a', 1, 1)]], s);
      expect(ok(applyOperations(base, [{ op: 'set_title', title: 'n' }])).validationState).toBe(s);
    }
    for (const s of ['valid', 'needs_review']) {
      const base = mk([[act('a', 1, 1)]], s);
      expect(ok(applyOperations(base, [{ op: 'remove', itemId: 'a' }])).validationState).toBe('needs_revalidation');
    }
  });
  it('never touches revision, owner, ids, createdAt, constraints', () => {
    const base = t();
    const r = ok(applyOperations(base, [{ op: 'remove', itemId: 'a' }, { op: 'set_title', title: 'N' }]));
    expect({ ...r, days: 0, title: 0, validationState: 0 }).toEqual({ ...base, days: 0, title: 0, validationState: 0 });
  });
});

describe('computeDiff never invents costs', () => {
  it('unknown transit fares and unknown activity costs are listed, not counted; walk/null fare is not unknown', () => {
    const before = mk([[act('a', 1, 100)]]);
    const after = mk([[act('a', 1, 100), leg('t1', 'transit', null), leg('w1', 'walk', null), act('u', 3, null), leg('t2', 'transit', 250)]]);
    const d = computeDiff(before, after);
    expect(d.unknownCostItems.sort()).toEqual(['t1', 'u']);
    expect(d.knownCostDelta).toEqual([{ amountMinor: 250, currency: 'JPY' }]);
  });
  it('mixed currencies stay separate (sorted, no conversion, zero deltas omitted)', () => {
    const before = mk([[act('a', 1, 100, 'JPY'), act('b', 3, 5, 'USD'), act('c', 5, 7, 'EUR')]]);
    const after = mk([[act('a', 1, 100, 'JPY'), act('b', 3, 9, 'USD'), act('n', 5, 30, 'EUR'), leg('f', 'transit', 400, 'JPY')]]);
    const d = computeDiff(before, after);
    expect(d.knownCostDelta).toEqual([
      { amountMinor: 23, currency: 'EUR' },
      { amountMinor: 400, currency: 'JPY' },
      { amountMinor: 4, currency: 'USD' },
    ]);
    expect(d.knownCostDelta.some((m) => m.amountMinor === 0)).toBe(false);
  });
  it('a currency that disappears yields a negative delta in that currency only', () => {
    const d = computeDiff(mk([[act('a', 1, 100, 'JPY'), act('b', 3, 5, 'USD')]]), mk([[act('a', 1, 100, 'JPY')]]));
    expect(d.knownCostDelta).toEqual([{ amountMinor: -5, currency: 'USD' }]);
  });
  it('trip with only unknown costs yields empty known delta and all ids listed', () => {
    const before = mk([[act('a', 1, null)]]);
    const after = mk([[act('a', 1, null), act('b', 3, null)]]);
    const d = computeDiff(before, after);
    expect(d.knownCostDelta).toEqual([]);
    expect(d.unknownCostItems).toEqual(['a', 'b']);
  });
  it('duration: untimed trips give null, not 0; null if either side is untimed', () => {
    const a = mk([[act('a', null, null)]]);
    expect(computeDiff(a, a).durationDeltaSeconds).toBeNull();
    const timed = mk([[act('a', 1, null), act('b', 3, null)]]);
    expect(computeDiff(a, timed).durationDeltaSeconds).toBeNull();
    expect(computeDiff(timed, a).durationDeltaSeconds).toBeNull();
  });
  it('null-fare transit and car legs are unknown cost; walk is not', () => {
    const d = computeDiff(mk([[]]), mk([[leg('t', 'transit', null), leg('c', 'car', null), leg('w', 'walk', null)]]));
    expect(d.unknownCostItems.sort()).toEqual(['c', 't']);
    expect(d.knownCostDelta).toEqual([]);
  });
});
