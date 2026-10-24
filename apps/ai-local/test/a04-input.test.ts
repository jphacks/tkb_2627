// A04 step 4: collect (K05) and the model input. Pure functions with a fake ContextClient; no network.
import { describe, expect, it } from 'vitest';
import { GenerationInput, PlanningContext, type PlaceInfo, type PermittedFact, type TripConstraints } from '@tkb/contracts';
import { domesticTrip, kanazawaPlaces } from '@tkb/fixtures';
import { factsForModel } from '@tkb/travel-data';
import { collectContext } from '../src/generation/collect.ts';
import { toGenerationInput } from '../src/generation/input.ts';
import type { ContextClient, ContextOutcome } from '../src/shared-client/index.ts';

const legsOf = () => domesticTrip.days.flatMap(d => d.items).filter(i => i.type === 'leg');
const fixtureCtx = (): PlanningContext => PlanningContext.parse({ places: structuredClone(kanazawaPlaces), legs: structuredClone(legsOf()), unknown: ['fare'], dataMode: 'fixture' });
const constraints = (over: Partial<TripConstraints> = {}): TripConstraints => ({ area: '金沢', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit', ...over });
const client = (out: ContextOutcome, seen: unknown[] = []): ContextClient => ({ getPlanningContext: async (_s, body) => (seen.push(body), out) });
const session = { upstream: { userId: 'u1', displayName: 'T', cookie: 'c', csrfToken: 't' } };
const sig = new AbortController().signal;
const collect = (out: ContextOutcome, c = constraints(), seen: unknown[] = []) => collectContext(client(out, seen), session, c, sig);
const withProv = (p: PlaceInfo, over: Partial<PlaceInfo['provenance']>): PlaceInfo => ({ ...p, provenance: { ...p.provenance, ...over } });

describe('collectContext (K05, before any model run)', () => {
  it('asks K05 for the area, mode, 8 places and the must-visit ids only', async () => {
    const seen: unknown[] = [];
    const r = await collect({ ok: true, context: fixtureCtx() }, constraints({ mustVisit: ['fx_kenrokuen'] }), seen);
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ area: '金沢', transportMode: 'transit', maxPlaces: 8, timeZone: 'Asia/Tokyo', placeIds: ['fx_kenrokuen'] }]);
    const none: unknown[] = [];
    await collect({ ok: true, context: fixtureCtx() }, constraints(), none);
    expect(none).toEqual([{ area: '金沢', transportMode: 'transit', maxPlaces: 8, timeZone: 'Asia/Tokyo' }]);
  });

  it('drops fixture leg times (samples, not a timetable) but keeps durations', async () => {
    const r = await collect({ ok: true, context: fixtureCtx() });
    if (!r.ok) throw new Error('expected ok');
    expect(r.ctx.legs.length).toBeGreaterThan(0);
    for (const l of r.ctx.legs) expect(l).toMatchObject({ departure: null, arrival: null });
    expect(r.ctx.legs.find(l => l.legId === 'fx_leg_1')!.durationSeconds).toBe(1200);
  });

  it('maps K05 failures to a stage failure with code and retryable', async () => {
    for (const [code, retryable] of [['PROVIDER_RATE_LIMIT', false], ['PROVIDER_UNAVAILABLE', true], ['UNAUTHENTICATED', false], ['RATE_LIMITED', true]] as const) {
      expect(await collect({ ok: false, code, retryable })).toEqual({ ok: false, code, retryable });
    }
  });

  it('fails with CONSTRAINT_UNSATISFIED when no place can be visited or a must-visit place is missing', async () => {
    const empty = PlanningContext.parse({ places: [], legs: [], unknown: ['places'], dataMode: 'fixture' });
    expect(await collect({ ok: true, context: empty })).toMatchObject({ ok: false, code: 'CONSTRAINT_UNSATISFIED' });
    expect(await collect({ ok: true, context: fixtureCtx() }, constraints({ mustVisit: ['fx_nowhere'] }))).toMatchObject({ ok: false, code: 'CONSTRAINT_UNSATISFIED' });
    // a station is not a place to plan a visit to
    expect(await collect({ ok: true, context: fixtureCtx() }, constraints({ mustVisit: ['fx_kanazawa_station'] }))).toMatchObject({ ok: false, code: 'CONSTRAINT_UNSATISFIED' });
    expect(await collect({ ok: true, context: fixtureCtx() }, constraints({ startDate: '2026-11-01', endDate: '2026-12-31' }))).toMatchObject({ ok: false, code: 'CONSTRAINT_UNSATISFIED' });
  });

  it('does not reject provider content that may not be stored: it is used in memory and projected at assembly (M1 on #28)', async () => {
    const live = fixtureCtx();
    live.places = live.places.map(p => withProv(p, { source: 'google_places', mayStore: false, maySendToModel: false }));
    const r = await collect({ ok: true, context: live }, constraints({ mustVisit: ['fx_sushi'] }));
    expect(r.ok).toBe(true);
  });
});

describe('toGenerationInput', () => {
  it('allowedPlaceIds are the visitable places only; the result is a valid K03 input with no fixed activities', () => {
    const input = toGenerationInput(constraints(), fixtureCtx());
    GenerationInput.parse(input);
    expect(input.allowedPlaceIds).toEqual(['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi', 'fx_sushi']);
    expect(input.allowedPlaceIds).not.toContain('fx_kanazawa_station');
    expect(input.fixedActivities).toEqual([]);
    expect(input.constraints).toEqual(constraints());
    expect(input.instructions).toMatch(/never invent/);
  });

  it('facts equal factsForModel: provider data without maySendToModel never reaches the model; legs without provenance do', () => {
    const ctx = fixtureCtx();
    ctx.places = ctx.places.map(p => (p.placeId === 'fx_omicho' ? withProv(p, { maySendToModel: false }) : p));
    ctx.legs = ctx.legs.map(l => (l.legId === 'fx_leg_2' && l.provenance ? { ...l, provenance: { ...l.provenance, maySendToModel: false } } : l));
    const input = toGenerationInput(constraints(), ctx);
    const all: PermittedFact[] = [...ctx.places.map((place): PermittedFact => ({ kind: 'place', place })), ...ctx.legs.map((leg): PermittedFact => ({ kind: 'leg', leg }))];
    expect(input.facts).toEqual(factsForModel(all));
    expect(input.facts.some(f => f.kind === 'place' && f.place.placeId === 'fx_omicho')).toBe(false);
    expect(input.facts.some(f => f.kind === 'leg' && f.leg.legId === 'fx_leg_2')).toBe(false);
    expect(input.facts.some(f => f.kind === 'leg' && f.leg.legId === 'fx_leg_3')).toBe(true); // our own unknown leg, no provenance
    // the id may go to the model; the place's content may not
    expect(input.allowedPlaceIds).toContain('fx_omicho');
  });
});

describe('AI_MAX_LIVE_LEGS', () => {
  it('defaults to 6, can lower the cap, and cannot exceed 6', async () => {
    const { loadConfig } = await import('../src/config.ts');
    expect(loadConfig({}).maxLiveLegs).toBe(6);
    expect(loadConfig({ AI_MAX_LIVE_LEGS: '3' }).maxLiveLegs).toBe(3);
    expect(() => loadConfig({ AI_MAX_LIVE_LEGS: '7' })).toThrow(/cannot exceed 6/);
    expect(() => loadConfig({ AI_MAX_LIVE_LEGS: '0' })).toThrow();
  });
});
