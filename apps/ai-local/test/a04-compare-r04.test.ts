// R04 (複数旅程の比較): wishes that cannot all be met give candidates that keep different places and explain
// DIFFERENT exclusions. Real assemble pipeline (planner sequenceDay + validateSchedule + D06 grouping); fake blueprint,
// fixture places only. Evidence level is "fixture": the blueprint is hand-written, not a live Claude answer.
import { describe, expect, it } from 'vitest';
import { PlanBatchCreate, type Activity, type PlaceInfo, type PlanBlueprint, type PlanningContext, type TravelLeg, type TripConstraints } from '@tkb/contracts';
import { kanazawaPlaces, kanazawaRouteSamples } from '@tkb/fixtures';
import { assembleBatch } from '../src/generation/assemble.ts';

const base = kanazawaPlaces.find(p => p.placeId === 'fx_21c_museum')!; // a `spot` with unknown hours
const spot = (id: string, name: string, openingHours: string | null): PlaceInfo => ({ ...structuredClone(base), placeId: id, name, openingHours });
const open = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map((id, i) => spot(`r04_${id}`, `地点${i + 1}`, null));
const morning = spot('r04_morning', '朝だけの市場', '（fixture）6:00-9:30'); // a 90 min stay from 09:00 cannot end by 09:30
const places = [...open, morning];
const legs: TravelLeg[] = places.flatMap(f =>
  places.filter(t => t !== f).map(t => ({ ...structuredClone(kanazawaRouteSamples[0]!), legId: `l_${f.placeId}_${t.placeId}`, fromPlaceId: f.placeId, toPlaceId: t.placeId, durationSeconds: 1800, fare: null, departure: null, arrival: null })),
);
const ctx: PlanningContext = { places, legs, unknown: [], dataMode: 'fixture' };
const constraints: TripConstraints = { area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit', mustVisit: ['r04_a1', 'r04_morning'] };
const ids = open.map(p => p.placeId);
const blueprint: PlanBlueprint = {
  schemaVersion: 1,
  candidates: [
    { candidateId: 'c1', title: '定番を回る案', activityOrder: ids.slice(0, 6), reasons: ['定番を優先'], warnings: [] },
    { candidateId: 'c2', title: '朝市場から始める案', activityOrder: ['r04_morning', 'r04_a1', 'r04_a2'], reasons: ['朝の市場を希望'], warnings: [] },
    { candidateId: 'c3', title: '逆順で巡る案', activityOrder: [...ids].reverse(), reasons: ['後半の地点を優先'], warnings: [] },
  ],
};
type Cand = { days: { items: { type: string }[] }[] };
const acts = (c: Cand) => c.days.flatMap(d => d.items).filter((i): i is Activity => i.type === 'activity');
const keptIds = (c: Cand) => acts(c).map(a => a.placeId!).sort();

describe('R04 candidate comparison with conflicting wishes (fixture)', () => {
  it('keeps different places per candidate and gives each its own exclusion reason; nothing is invented', async () => {
    const r = await assembleBatch(blueprint, structuredClone(ctx), constraints, 'b'.repeat(64));
    if (!r.ok) throw new Error(r.code);
    PlanBatchCreate.parse(r.batch);
    const [c1, c2, c3] = r.batch.candidates;
    if (!c1 || !c2 || !c3) throw new Error('expected 3 candidates');
    const warn = (c: { warnings: string[] }, re: RegExp) => c.warnings.filter(w => re.test(w));

    // Different kept places.
    const kept = [c1, c2, c3].map(keptIds);
    expect(new Set(kept.map(k => k.join())).size).toBe(3);
    expect(kept[0]).not.toContain('r04_morning');
    expect(kept[1]).not.toContain('r04_morning');

    // c1: six stops of 90 min + 30 min legs overrun 09:00-19:00, so the sixth is excluded as "does not fit".
    expect(c1.excludedPlaceIds).toEqual(['r04_a6']);
    expect(warn(c1, /「地点6」は日程に収まらないため除外しました。/)).toHaveLength(1);
    // c2: the morning-only place cannot be visited within its hours: excluded as closed; the must-visit wish is not met, and says so.
    expect(c2.excludedPlaceIds).toEqual(['r04_morning']);
    expect(warn(c2, /「朝だけの市場」は営業時間外のため除外しました。/)).toHaveLength(1);
    expect(c2.validationState).toBe('invalid'); // must-visit missing: never presented as valid
    // c3: seven stops in reverse; the tail of the order drops out. A different set than c1.
    expect(c3.excludedPlaceIds.length).toBeGreaterThan(0);
    expect(c3.excludedPlaceIds).not.toEqual(c1.excludedPlaceIds);
    expect(c3.excludedPlaceIds).not.toContain('r04_a6');
    expect(warn(c3, /日程に収まらないため除外しました/)).toHaveLength(c3.excludedPlaceIds.length);

    // Exclusion messages share nothing between candidates; the reason KIND differs c1 vs c2.
    const ex = (c: { warnings: string[] }) => c.warnings.filter(w => w.includes('除外しました'));
    for (const [a, b] of [[c1, c2], [c1, c3], [c2, c3]] as const) expect(ex(a).filter(w => ex(b).includes(w))).toEqual([]);
    expect(ex(c1).some(w => w.includes('日程に収まらない'))).toBe(true);
    expect(ex(c2).some(w => w.includes('営業時間外'))).toBe(true);
    expect(ex(c2).some(w => w.includes('日程に収まらない'))).toBe(false);

    // Every excluded id is a known place, none is also kept, and no cost is made up.
    for (const [i, c] of [c1, c2, c3].entries()) {
      for (const id of c.excludedPlaceIds) {
        expect(places.some(p => p.placeId === id)).toBe(true);
        expect(kept[i]).not.toContain(id);
      }
      for (const a of acts(c)) expect(a).toMatchObject({ cost: null, costStatus: 'unknown' });
      expect(c.hasUnknownCost).toBe(true);
      expect(c.totalKnownCost).toEqual([]);
    }
  });

  it('an unknown leg stays unknown: the stop is untimed and the candidate says so instead of guessing', async () => {
    const holes = structuredClone(ctx);
    holes.legs = holes.legs.filter(l => !(l.fromPlaceId === 'r04_a1' && l.toPlaceId === 'r04_a2'));
    const b: PlanBlueprint = { schemaVersion: 1, candidates: [{ candidateId: 'u1', activityOrder: ['r04_a1', 'r04_a2', 'r04_a3'], reasons: [], warnings: [] }] };
    const r = await assembleBatch(b, holes, { ...constraints, mustVisit: [] }, 'c'.repeat(64));
    if (!r.ok) throw new Error(r.code);
    const c = r.batch.candidates[0]!;
    expect(acts(c).slice(1).every(a => a.start === null)).toBe(true);
    expect(c.validationState).not.toBe('valid');
    expect(c.warnings.some(w => w.includes('移動時間不明'))).toBe(true);
  });
});
