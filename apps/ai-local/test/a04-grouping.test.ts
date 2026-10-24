// A04 rework for #32 R4: nearby stops become one parent, food right after a meal is reported. Fixtures only.
import { describe, expect, it } from 'vitest';
import { PlanBatchCreate, type Activity, type PlaceInfo, type PlanBlueprint, type PlanningContext, type TravelLeg, type TripConstraints } from '@tkb/contracts';
import { kanazawaPlaces, kanazawaRouteSamples } from '@tkb/fixtures';
import { assembleBatch, MEAL_AFTER_MEAL_WARNING } from '../src/generation/assemble.ts';

const KEY = 'b'.repeat(64);
const cons: TripConstraints = { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit' };
const bp = (order: string[]): PlanBlueprint => ({ schemaVersion: 1, candidates: [{ candidateId: 'c1', activityOrder: order, reasons: ['r'], warnings: [] }] });
const walk = (id: string, from: string, to: string): TravelLeg => ({ ...kanazawaRouteSamples[0]!, legId: id, fromPlaceId: from, toPlaceId: to, mode: 'walk', durationSeconds: 300, fare: null, departure: null, arrival: null });
const placeAt = (id: string, lat: number, lng: number): PlaceInfo => ({ ...kanazawaPlaces.find(p => p.placeId === id)!, location: { lat, lng }, openingHours: null });
const items = (b: { candidates: { days: { items: unknown[] }[] }[] }) => b.candidates[0]!.days.flatMap(d => d.items as (Activity | TravelLeg)[]);

describe('assembleBatch grouping (#32 R4)', () => {
  it('a market walk and the sushi lunch next to it become one parent with a child, and the leg between them is dropped', async () => {
    const ctx: PlanningContext = {
      places: [placeAt('fx_omicho', 36.571, 136.656), placeAt('fx_sushi', 36.5705, 136.6565)],
      legs: [walk('l1', 'fx_omicho', 'fx_sushi')],
      unknown: [],
      dataMode: 'fixture',
    };
    const r = await assembleBatch(bp(['fx_omicho', 'fx_sushi']), ctx, cons, KEY);
    if (!r.ok) throw new Error(r.code);
    PlanBatchCreate.parse(r.batch);
    const all = items(r.batch);
    const acts = all.filter((i): i is Activity => i.type === 'activity');
    const parent = acts.find(a => a.kind === 'free_walk')!;
    const child = acts.find(a => a.kind === 'meal')!;
    expect(parent.parentActivityId ?? null).toBeNull();
    expect(child.parentActivityId).toBe(parent.activityId);
    expect(all.filter(i => i.type === 'leg')).toEqual([]);
  });

  it('a meal followed by a food walk far away is reported and never valid', async () => {
    const ctx: PlanningContext = {
      places: [placeAt('fx_sushi', 36.5, 136.6), placeAt('fx_omicho', 36.6, 136.7)],
      legs: [walk('l1', 'fx_sushi', 'fx_omicho')],
      unknown: [],
      dataMode: 'fixture',
    };
    const r = await assembleBatch(bp(['fx_sushi', 'fx_omicho']), ctx, cons, KEY);
    if (!r.ok) throw new Error(r.code);
    const c = r.batch.candidates[0]!;
    expect(c.warnings).toContain(MEAL_AFTER_MEAL_WARNING);
    expect(c.validationState).not.toBe('valid');
  });
});
