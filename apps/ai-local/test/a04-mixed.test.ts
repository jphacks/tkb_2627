// A04 step 7 (M1 on #28): mixed/live data. Provider content that may not be stored never reaches the stored batch.
// Fake ContextClient only; no network, no Google call.
import { describe, expect, it } from 'vitest';
import { PlanBatchCreate, PlanningContext, type Activity, type PlanBlueprint, type PlaceInfo, type PlanningContextRequest, type TravelLeg, type TripConstraints } from '@tkb/contracts';
import { kanazawaPlaces } from '@tkb/fixtures';
import { storable } from '../../server/src/trips/index.ts';
import { batchReferencesOnlyKnownPlaces } from '../../server/src/trips/generation/verify-batch.ts';
import { MAX_LIVE_LEG_PAIRS, assembleBatch } from '../src/generation/assemble.ts';
import { createPipeline } from '../src/generation/pipeline.ts';
import { INSUFFICIENT_PLACE_WARNING, LEG_REFETCH_WARNING, PLACEHOLDER_NAME, PLACE_REFETCH_WARNING } from '../src/generation/project.ts';
import type { ContextClient } from '../src/shared-client/index.ts';

const GOOGLE_ROUTES = { source: 'google_routes', fetchedAt: '2026-10-24T00:00:00Z', attribution: 'Google Maps', maySendToModel: false, mayStore: false, mayExport: false, retainUntil: '2026-10-24T00:00:00Z' };
const liveLeg = (from: string, to: string, mode: TravelLeg['mode'] = 'transit'): TravelLeg => ({
  type: 'leg', legId: `live_${from}_${to}`, mode, fromPlaceId: from, toPlaceId: to, departure: null, arrival: null,
  durationSeconds: 1200, lineName: 'LIVE-LINE', platform: 'LIVE-PLATFORM', transfers: 1, fare: { amountMinor: 500, currency: 'JPY' }, dataStatus: 'verified', provenance: GOOGLE_ROUTES,
});
const cons = (over: Partial<TripConstraints> = {}): TripConstraints => ({ area: '金沢', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: 'Asia/Tokyo', transportMode: 'transit', ...over });
const bp = (...orders: string[][]): PlanBlueprint => ({ schemaVersion: 1, candidates: orders.map((o, i) => ({ candidateId: `c${i + 1}`, activityOrder: o, reasons: [], warnings: [] })) });
const KEY = 'b'.repeat(64);
const session = { upstream: { userId: 'u1', displayName: 'T', cookie: 'c', csrfToken: 't' } };

describe('mixed mode: fixture places, live legs', () => {
  const places = structuredClone(kanazawaPlaces);
  const ctx: PlanningContext = { places, legs: [liveLeg('fx_kanazawa_station', 'fx_kenrokuen')], unknown: [], dataMode: 'mixed' };

  it('schedules with the live duration but stores no live route detail, and says so', async () => {
    const r = await assembleBatch(bp(['fx_kenrokuen']), ctx, cons({ departure: { placeId: 'fx_kanazawa_station', label: null, time: null } }), KEY);
    if (!r.ok) throw new Error(r.code);
    const c = r.batch.candidates[0]!;
    const items = c.days[0]!.items;
    const act = items.find((i): i is Activity => i.type === 'activity')!;
    expect(act.start!.utc).toBe('2026-11-01T00:20:00Z'); // 09:00 JST + the 20 min the route lookup returned: a computed time, allowed
    const leg = items.find((i): i is TravelLeg => i.type === 'leg')!;
    expect(leg).toMatchObject({ durationSeconds: null, fare: null, lineName: null, platform: null, transfers: null, departure: null, arrival: null, dataStatus: 'unknown' });
    expect(JSON.stringify(r.batch)).not.toMatch(/LIVE-LINE|LIVE-PLATFORM|"amountMinor":500/);
    expect(c.totalKnownCost).toEqual([]); // the live fare is not smuggled in through the total
    expect(c.warnings).toContain(LEG_REFETCH_WARNING);
    expect(c.validationState).toBe('needs_review');
    // the K07 retention rule and the reference check both pass
    const now = Date.parse('2026-10-25T00:00:00Z');
    expect(r.batch.places.every(p => storable(p.provenance, now))).toBe(true);
    expect(c.days.flatMap(d => d.items).every(i => i.type !== 'leg' || (i.provenance !== null && storable(i.provenance, now)))).toBe(true);
    expect(batchReferencesOnlyKnownPlaces(r.batch.candidates, r.batch.places)).toBe(true);
    PlanBatchCreate.parse(r.batch);
  });
});

describe('live places: only the id is kept', () => {
  const secret = (p: PlaceInfo): PlaceInfo => ({
    ...p, name: `SECRET-${p.placeId}`, description: 'SECRET-DESC', openingHours: null, location: { lat: 36.5, lng: 136.6 },
    provenance: { source: 'google_places', fetchedAt: '2026-10-24T00:00:00Z', attribution: 'Google Maps', maySendToModel: false, mayStore: false, mayExport: false, retainUntil: '2026-10-24T00:00:00Z' },
  });
  const places = kanazawaPlaces.filter(p => p.kind !== 'station').slice(0, 3).map(secret);
  const ids = places.map(p => p.placeId);
  const ctx: PlanningContext = { places, legs: [], unknown: ['legs'], dataMode: 'live' };

  it('stored places, titles and warnings carry no provider content; the candidate needs review and says why', async () => {
    const r = await assembleBatch(bp(ids), ctx, cons(), KEY);
    if (!r.ok) throw new Error(r.code);
    const text = JSON.stringify(r.batch);
    expect(text).not.toMatch(/SECRET/);
    for (const p of r.batch.places) {
      expect(p).toMatchObject({ name: PLACEHOLDER_NAME, location: null, description: null, openingHours: null, photo: null, kind: 'other' });
      expect(p.provenance).toMatchObject({ mayStore: true, maySendToModel: false, mayExport: false });
    }
    const c = r.batch.candidates[0]!;
    expect(c.validationState).toBe('needs_review');
    expect(c.warnings).toEqual(expect.arrayContaining([PLACE_REFETCH_WARNING, INSUFFICIENT_PLACE_WARNING]));
    expect(c.days.flatMap(d => d.items).filter((i): i is Activity => i.type === 'activity').every(a => a.title === PLACEHOLDER_NAME)).toBe(true);
    expect(r.batch.places.map(p => p.placeId).sort()).toEqual([...ids].sort());
  });
});

describe('pipeline in mixed mode: the second K05 call', () => {
  const places = structuredClone(kanazawaPlaces);
  function setup() {
    const seen: PlanningContextRequest[] = [];
    const client: ContextClient = {
      getPlanningContext: async (_s, body) => {
        seen.push(body);
        if (!body.legs) return { ok: true, context: PlanningContext.parse({ places, legs: [], unknown: ['legs'], dataMode: 'mixed' }) };
        return { ok: true, context: PlanningContext.parse({ places, legs: body.legs.map(q => liveLeg(q.fromPlaceId, q.toPlaceId, q.mode)), unknown: [], dataMode: 'mixed' }) };
      },
    };
    const pipeline = createPipeline({ contextClient: client, planClient: { savePlanBatch: async () => ({ ok: false, code: 'UNAVAILABLE', retryable: true }), findPlanBatchByGenerationId: async () => null }, sessions: { findUpstream: () => ({ id: 's', csrfToken: 'x', expiresAt: 1, ...session }) } });
    return { seen, pipeline };
  }
  const c = cons({ departure: { placeId: 'fx_kanazawa_station', label: null, time: null } });
  const req = { constraints: c, baseTripId: null, baseRevision: null } as const;

  it('first call asks for places only (with the zone); build then asks for the used segments, deduplicated and at most 8 in all', async () => {
    const { seen, pipeline } = setup();
    const col = await pipeline.collect('u1', req, new AbortController().signal);
    if (!col.ok) throw new Error(col.code);
    expect(seen[0]).toMatchObject({ area: '金沢', timeZone: 'Asia/Tokyo' });
    expect(seen[0]!.legs).toBeUndefined();
    const b = await pipeline.build(
      'u1',
      bp(['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi', 'fx_sushi'], ['fx_kenrokuen', 'fx_21c_museum', 'fx_higashi', 'fx_omicho', 'fx_sushi'], ['fx_sushi', 'fx_omicho', 'fx_kenrokuen', 'fx_higashi', 'fx_21c_museum']),
      col.ctx,
      KEY,
      new AbortController().signal,
    );
    if (!b.ok) throw new Error(b.code);
    const asked = seen.slice(1).flatMap(s => s.legs ?? []);
    expect(asked.length).toBeLessThanOrEqual(6); // M1: at most 6 Routes calls per job
    expect(seen.filter(x => x.legs).length).toBe(1); // one second call for the whole job, not one per candidate
    expect(new Set(asked.map(q => `${q.fromPlaceId}|${q.toPlaceId}`)).size).toBe(asked.length);
    expect(asked[0]).toMatchObject({ fromPlaceId: 'fx_kanazawa_station', toPlaceId: 'fx_kenrokuen', departureUtc: '2026-11-01T00:00:00Z', mode: 'transit' });
    expect(asked.find(q => q.fromPlaceId === 'fx_kenrokuen' && q.toPlaceId === 'fx_21c_museum')!.mode).toBe('walk'); // ~0.5 km
    expect(JSON.stringify(b.batch)).not.toMatch(/LIVE-LINE|LIVE-PLATFORM/);
    expect(b.batch.candidates.every(x => x.warnings.includes(LEG_REFETCH_WARNING) || x.days.every(d => d.items.every(i => i.type !== 'leg')))).toBe(true);
  });

  it('3 candidates x 5 stops: all candidates share one lookup of at most 6 distinct pairs; pairs beyond the cap stay untimed with the warning', async () => {
    const { seen, pipeline } = setup();
    const col = await pipeline.collect('u1', req, new AbortController().signal);
    if (!col.ok) throw new Error(col.code);
    const five = ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi', 'fx_sushi'];
    const b = await pipeline.build('u1', bp(five, [...five].reverse(), [five[2]!, five[0]!, five[4]!, five[1]!, five[3]!]), col.ctx, KEY, new AbortController().signal);
    if (!b.ok) throw new Error(b.code);
    const calls = seen.filter(x => x.legs);
    expect(calls).toHaveLength(1);
    const asked = calls[0]!.legs!;
    expect(asked.length).toBe(MAX_LIVE_LEG_PAIRS);
    expect(new Set(asked.map(q => `${q.fromPlaceId}|${q.toPlaceId}`)).size).toBe(asked.length);
    // round-robin: every candidate's first pair is among them
    expect(asked.some(q => q.toPlaceId === 'fx_sushi' && q.fromPlaceId === 'fx_kanazawa_station')).toBe(true);
    const legCount = b.batch.candidates.flatMap(x => x.days.flatMap(d => d.items)).filter(i => i.type === 'leg').length;
    expect(legCount).toBeGreaterThan(0);
    expect(b.batch.candidates.some(x => x.warnings.some(w => w.includes('移動時間不明')))).toBe(true);
  });

  it('a configured cap can only lower the limit', async () => {
    const seen: PlanningContextRequest[] = [];
    const client: ContextClient = {
      getPlanningContext: async (_s, body) => (seen.push(body), { ok: true, context: PlanningContext.parse({ places, legs: [], unknown: [], dataMode: 'mixed' }) }),
    };
    const mk = (maxLiveLegs: number) => createPipeline({ contextClient: client, planClient: { savePlanBatch: async () => ({ ok: false, code: 'UNAVAILABLE', retryable: true }), findPlanBatchByGenerationId: async () => null }, sessions: { findUpstream: () => ({ id: 's', csrfToken: 'x', expiresAt: 1, ...session }) }, maxLiveLegs });
    const col = await mk(2).collect('u1', req, new AbortController().signal);
    if (!col.ok) throw new Error(col.code);
    const five = ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi', 'fx_sushi'];
    await mk(2).build('u1', bp(five), col.ctx, KEY, new AbortController().signal);
    await mk(99).build('u1', bp(five, [...five].reverse()), col.ctx, KEY, new AbortController().signal);
    expect(seen.filter(x => x.legs).map(x => x.legs!.length)).toEqual([2, 6]);
  });

  it('a failed second call leaves the stops without times instead of inventing travel', async () => {
    const { pipeline } = setup();
    const col = await pipeline.collect('u1', req, new AbortController().signal);
    if (!col.ok) throw new Error(col.code);
    const failing = createPipeline({
      contextClient: { getPlanningContext: async (_s, body) => (body.legs ? { ok: false, code: 'PROVIDER_RATE_LIMIT', retryable: false } : { ok: true, context: PlanningContext.parse({ places, legs: [], unknown: ['legs'], dataMode: 'mixed' }) }) },
      planClient: { savePlanBatch: async () => ({ ok: false, code: 'UNAVAILABLE', retryable: true }), findPlanBatchByGenerationId: async () => null },
      sessions: { findUpstream: () => ({ id: 's', csrfToken: 'x', expiresAt: 1, ...session }) },
    });
    const b = await failing.build('u1', bp(['fx_kenrokuen', 'fx_21c_museum']), col.ctx, KEY, new AbortController().signal);
    if (!b.ok) throw new Error(b.code);
    const items = b.batch.candidates[0]!.days.flatMap(d => d.items);
    expect(items.filter(i => i.type === 'leg')).toEqual([]);
    expect(items.filter((i): i is Activity => i.type === 'activity').every(a => a.start === null)).toBe(true); // travel from the start place is unknown, so no time is made up
    expect(b.batch.candidates[0]!.warnings.some(w => w.includes('移動時間不明'))).toBe(true);
  });
});
