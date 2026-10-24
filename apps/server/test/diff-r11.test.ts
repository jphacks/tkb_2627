import { describe, expect, it } from 'vitest';
import type { Trip } from '@tkb/contracts';
import { fixtureTrips } from '@tkb/fixtures';
import { computeDiff } from '../src/trips/operations.ts';

const base = (): Trip => structuredClone(fixtureTrips[0]!);
type Act = Extract<Trip['days'][number]['items'][number], { type: 'activity' }>;
const firstPricedActivity = (t: Trip): Act =>
  t.days.flatMap((d) => d.items).find((i): i is Act => i.type === 'activity' && i.cost !== null)!;

describe('K10 diff follows R11 (unknown cost is never 0)', () => {
  it('a known cost that becomes unknown is not counted as a saving', () => {
    const before = base();
    const after = base();
    const act = firstPricedActivity(after);
    act.cost = null;
    act.costStatus = 'unknown';
    const d = computeDiff(before, after);
    expect(d.knownCostDelta).toEqual([]);
    expect(d.unknownCostItems).toContain(act.activityId);
  });

  it('an unknown cost that becomes known is not counted as a new expense', () => {
    const before = base();
    const act = firstPricedActivity(before);
    act.cost = null;
    const d = computeDiff(before, base());
    expect(d.knownCostDelta).toEqual([]);
    expect(d.unknownCostItems).toContain(act.activityId);
  });

  it('changing a known cost reports the per-currency delta only', () => {
    const before = base();
    const after = base();
    const act = firstPricedActivity(after);
    act.cost = { ...act.cost!, amountMinor: act.cost!.amountMinor + 500 };
    expect(computeDiff(before, after).knownCostDelta).toEqual([{ amountMinor: 500, currency: act.cost.currency }]);
  });

  it('walking legs without a fare are not unknown costs', () => {
    const t = base();
    const walks = t.days.flatMap((d) => d.items).filter((i) => i.type === 'leg' && i.mode === 'walk');
    expect(walks.length).toBeGreaterThan(0);
    const d = computeDiff(t, structuredClone(t));
    for (const w of walks) expect(d.unknownCostItems).not.toContain(w.type === 'leg' ? w.legId : '');
  });

  it('duration is unknown (null) when any item lacks times, never 0', () => {
    const t = base();
    expect(t.days.flatMap((d) => d.items).some((i) => (i.type === 'leg' ? i.arrival === null : i.end === null))).toBe(true);
    expect(computeDiff(t, structuredClone(t)).durationDeltaSeconds).toBeNull();
  });
});
