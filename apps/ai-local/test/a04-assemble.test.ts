// A04 step 4: blueprint -> K07 body. Deterministic planner + fixture facts; no network, no model.
import { describe, expect, it } from 'vitest';
import { PlanBatchCreate, PlanningContext, type Activity, type PlaceInfo, type PlanBlueprint, type TravelLeg, type TripConstraints } from '@tkb/contracts';
import { domesticTrip, kanazawaPlaces } from '@tkb/fixtures';
import { assembleBatch, consecutivePairs, STAY_ASSUMPTION_WARNING, UNTIMED_WARNING } from '../src/generation/assemble.ts';

const nulled = (l: TravelLeg): TravelLeg => ({ ...l, departure: null, arrival: null });
const fixtureLegs = domesticTrip.days.flatMap(d => d.items).filter((i): i is TravelLeg => i.type === 'leg').map(nulled);
const ctx = (): PlanningContext => ({ places: structuredClone(kanazawaPlaces), legs: structuredClone(fixtureLegs), unknown: [], dataMode: 'fixture' });
const cons = (over: Partial<TripConstraints> = {}): TripConstraints => ({ area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit', ...over });
const bp = (...cands: { id: string; order: string[]; extra?: object }[]): PlanBlueprint => ({
  schemaVersion: 1,
  candidates: cands.map(c => ({ candidateId: c.id, activityOrder: c.order, reasons: ['r'], warnings: [], ...c.extra })),
});
const KEY = 'a'.repeat(64);
async function ok(b: PlanBlueprint, c: PlanningContext, k: TripConstraints) {
  const r = await assembleBatch(b, c, k, KEY);
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.batch;
}
const acts = (b: Awaited<ReturnType<typeof ok>>, ci = 0) => b.candidates[ci]!.days.flatMap(d => d.items).filter((i): i is Activity => i.type === 'activity');

describe('assembleBatch', () => {
  it('builds timed days from known legs, with unknown cost kept unknown and fares only from the leg', async () => {
    const b = await ok(bp({ id: 'c1', order: ['fx_kenrokuen', 'fx_21c_museum'] }), ctx(), cons({ departure: { placeId: 'fx_kanazawa_station', label: null, time: null }, mustVisit: ['fx_kenrokuen'] }));
    PlanBatchCreate.parse(b);
    expect(b).toMatchObject({ schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: KEY });
    const items = b.candidates[0]!.days[0]!.items;
    expect(items.map(i => (i.type === 'leg' ? i.legId : i.activityId.startsWith('act_c1_') ? i.title : '?'))).toEqual(['fx_leg_1', '兼六園', 'fx_leg_2', '金沢21世紀美術館']);
    for (const l of items.filter((i): i is TravelLeg => i.type === 'leg')) expect(l).toMatchObject({ departure: null, arrival: null });
    for (const a of acts(b)) {
      expect(a).toMatchObject({ cost: null, costStatus: 'unknown', fixed: false, status: 'planned', kind: 'visit' });
      expect(a.start).not.toBeNull();
    }
    expect(acts(b)[0]!.start!.utc).toBe('2026-11-01T00:20:00Z'); // 09:00 JST + 20 min bus
    const c = b.candidates[0]!;
    expect(c.totalKnownCost).toEqual([{ amountMinor: 200, currency: 'JPY' }]); // only the bus fare the fixture leg carries
    expect(c.hasUnknownCost).toBe(true);
    expect(c.validationState).toBe('needs_review'); // museum hours unknown
    expect(c.warnings).toContain(STAY_ASSUMPTION_WARNING);
    expect(b.places.map(p => p.placeId)).toEqual(['fx_kanazawa_station', 'fx_kenrokuen', 'fx_21c_museum']);
  });

  it('an unknown leg leaves the stop and everything after it untimed (no invented time), with a warning', async () => {
    const b = await ok(bp({ id: 'c1', order: ['fx_21c_museum', 'fx_sushi', 'fx_omicho'] }), ctx(), cons());
    const items = b.candidates[0]!.days[0]!.items;
    expect(items.filter(i => i.type === 'leg')).toEqual([]);
    const [museum, sushi, omicho] = acts(b);
    expect(museum!.start).not.toBeNull();
    expect(sushi).toMatchObject({ kind: 'meal', start: null, end: null });
    expect(omicho).toMatchObject({ kind: 'free_walk', areaName: '近江町市場', start: null });
    expect(b.candidates[0]!.warnings).toContain(UNTIMED_WARNING);
    expect(b.candidates[0]!.validationState).toBe('needs_review');
    expect(JSON.stringify(b)).not.toMatch(/"amountMinor":0\b/);
  });

  it('carries what does not fit to the next day, and drops (and reports) what fits nowhere', async () => {
    const places: PlaceInfo[] = Array.from({ length: 8 }, (_, i) => ({ ...kanazawaPlaces[1]!, placeId: `p${i}`, name: `P${i}`, openingHours: null }));
    const legs: TravelLeg[] = places.slice(0, -1).map((p, i) => ({ ...fixtureLegs[0]!, legId: `l${i}`, fromPlaceId: p.placeId, toPlaceId: places[i + 1]!.placeId, durationSeconds: 1800, fare: null }));
    const c: PlanningContext = { places, legs, unknown: [], dataMode: 'fixture' };
    const order = places.map(p => p.placeId);
    const two = await ok(bp({ id: 'c1', order }), c, cons({ endDate: '2026-11-02' }));
    const days = two.candidates[0]!.days;
    expect(days).toHaveLength(2);
    const counts = days.map(d => d.items.filter(i => i.type === 'activity').length);
    expect(counts[0]! + counts[1]!).toBe(8);
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBeGreaterThan(0);
    expect(two.candidates[0]!.excludedPlaceIds).toEqual([]);
    // one day only: the rest is reported as excluded with a warning, never silently lost
    const one = await ok(bp({ id: 'c1', order }), c, cons());
    const kept = acts(one).length;
    expect(kept).toBeLessThan(8);
    expect(one.candidates[0]!.excludedPlaceIds).toHaveLength(8 - kept);
    expect(one.candidates[0]!.warnings.some(w => w.includes('日程に収まらない'))).toBe(true);
  });

  it('a missing must-visit place makes the candidate invalid', async () => {
    const b = await ok(bp({ id: 'c1', order: ['fx_kenrokuen'] }), ctx(), cons({ mustVisit: ['fx_omicho'] }));
    expect(b.candidates[0]!.validationState).toBe('invalid');
  });

  it('rejects duplicate candidate ids, overlong ids, unknown or non-visitable places as INVALID_OUTPUT', async () => {
    const dup = await assembleBatch(bp({ id: 'c1', order: ['fx_kenrokuen'] }, { id: 'c1', order: ['fx_omicho'] }), ctx(), cons(), KEY);
    expect(dup).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' });
    expect(await assembleBatch(bp({ id: 'c'.repeat(101), order: ['fx_kenrokuen'] }), ctx(), cons(), KEY)).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' });
    expect(await assembleBatch(bp({ id: 'c1', order: ['fx_ghost'] }), ctx(), cons(), KEY)).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' });
    expect(await assembleBatch(bp({ id: 'c1', order: ['fx_kanazawa_station'] }), ctx(), cons(), KEY)).toMatchObject({ ok: false, code: 'INVALID_OUTPUT' });
  });

  it('caps model text (title 200, reasons and warnings 10 x 200) and keeps its own warnings after the model ones', async () => {
    const long = 'x'.repeat(500);
    const extra = { title: long, reasons: Array.from({ length: 15 }, () => long), warnings: Array.from({ length: 15 }, () => long) };
    const b = await ok(bp({ id: 'c1', order: ['fx_kenrokuen'], extra }), ctx(), cons());
    const c = b.candidates[0]!;
    expect(c.title).toHaveLength(200);
    expect(c.reasons).toHaveLength(10);
    expect(c.reasons.every(r => r.length === 200)).toBe(true);
    expect(c.warnings.slice(0, 10).every(w => w.length === 200)).toBe(true);
    expect(c.warnings).toContain(STAY_ASSUMPTION_WARNING);
  });

  it('is deterministic: the same inputs give byte-identical JSON, and the activity ids are stable', async () => {
    const run = async () => JSON.stringify(await ok(bp({ id: 'c1', order: ['fx_kenrokuen', 'fx_21c_museum'] }, { id: 'c2', order: ['fx_omicho', 'fx_higashi'] }), ctx(), cons({ endDate: '2026-11-02' })));
    const [a, b] = [await run(), await run()];
    expect(a).toBe(b);
    expect(a).toMatch(/"activityId":"act_c1_[0-9a-f]{8}"/);
  });

  it('consecutivePairs de-duplicates and caps', () => {
    expect(consecutivePairs('s', ['a', 'b', 'a', 'b'])).toEqual([{ from: 's', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    expect(consecutivePairs(null, Array.from({ length: 20 }, (_, i) => `p${i}`))).toHaveLength(8);
  });
});
