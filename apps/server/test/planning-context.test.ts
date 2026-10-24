// K05 POST /api/v1/planning-context (A04 step 1): fixture sources only, no real provider call.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { ApiError, PlanningContext } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { CallBudget, DailyQuota, Gate, PolicyError } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { registerPlanningContext } from '../src/trips/generation/index.ts';
import { createContextSources, type ContextSources } from '../src/trips/generation/sources.ts';
import { createUserLimiter } from '../src/trips/generation/user-limit.ts';

const PW = 'correct horse battery';
const apps: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

async function make() {
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: pwHash, displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  apps.push(app);
  const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
  const h = { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
  const post = (payload: unknown, headers = h) => app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: payload as object, headers });
  return { app, post };
}

describe('K05 over the real shared app (fixture mode)', () => {
  it('requires a session', async () => {
    const { post } = await make();
    const r = await post({ area: '金沢', transportMode: 'transit' }, {} as never);
    expect(r.statusCode).toBe(401);
  });

  it('rejects a CSRF-less state-changing call and an invalid body', async () => {
    const { app, post } = await make();
    const noCsrf = await app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: { area: 'x', transportMode: 'transit' }, headers: { cookie: 'tkb_session=bogus' } });
    expect([401, 403]).toContain(noCsrf.statusCode);
    for (const bad of [{}, { area: '', transportMode: 'transit' }, { area: 'x', transportMode: 'boat' }, { area: 'x', transportMode: 'car', maxPlaces: 99 }, { area: 'x', transportMode: 'car', placeIds: ['a b'] }]) {
      const r = await post(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('returns fixture places and legs for Kanazawa, labelled fixture, no-store, provenance unchanged', async () => {
    const { post } = await make();
    const r = await post({ area: 'Kanazawa', transportMode: 'transit', maxPlaces: 8, placeIds: ['fx_kenrokuen'] });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const c = PlanningContext.parse(r.json());
    expect(c.dataMode).toBe('fixture');
    expect(c.places[0]!.placeId).toBe('fx_kenrokuen');
    expect(c.places.map(p => p.placeId)).toContain('fx_sushi');
    expect(c.places.every(p => p.provenance.source === 'fixture' && p.dataStatus === 'fixture')).toBe(true);
    expect(c.legs.map(l => l.legId)).toEqual(expect.arrayContaining(['fx_leg_1', 'fx_leg_2']));
    expect(c.unknown).toEqual(expect.arrayContaining(['fare', 'legs', 'openingHours']));
    expect(c.unknown).not.toContain('mustVisit');
    // 21c -> sushi is an unknown leg: no duration, no provenance, nothing invented
    const unknownLeg = c.legs.find(l => l.legId === 'fx_leg_3');
    expect(unknownLeg).toMatchObject({ durationSeconds: null, fare: null, provenance: null, dataStatus: 'unknown' });
  });

  it('caps maxPlaces, names missing must-visit ids, and answers an unknown area with an empty list (200)', async () => {
    const { post } = await make();
    const capped = PlanningContext.parse((await post({ area: '金沢', transportMode: 'car', maxPlaces: 3, placeIds: ['fx_omicho', 'nope'] })).json());
    expect(capped.places).toHaveLength(3);
    expect(capped.places[0]!.placeId).toBe('fx_omicho');
    expect(capped.unknown).toContain('mustVisit');
    const none = await post({ area: 'Atlantis', transportMode: 'transit' });
    expect(none.statusCode).toBe(200);
    expect(PlanningContext.parse(none.json())).toMatchObject({ places: [], legs: [], unknown: expect.arrayContaining(['places']) });
  });
});

describe('K05 error mapping and limits (fake sources)', () => {
  const miniApp = (places: ContextSources['places'], limiter = createUserLimiter({ perDay: 5 })) => {
    const app = Fastify({ logger: false });
    app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'u1', displayName: 'U' }));
    const real = createContextSources({ providerMode: 'fixture' });
    registerPlanningContext(app, { providerMode: 'fixture' } as never, { sources: { ...real, places }, limiter });
    apps.push(app);
    return app;
  };
  const fire = (app: ReturnType<typeof miniApp>) => app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: { area: 'x', transportMode: 'transit' } });

  it.each([
    [new PolicyError('PROVIDER_RATE_LIMIT', 'q', false), 429, 'PROVIDER_RATE_LIMIT', false],
    [new PolicyError('PROVIDER_UNAVAILABLE', 'q', true), 503, 'PROVIDER_UNAVAILABLE', true],
    [new PolicyError('PROVIDER_UNSUPPORTED_REGION', 'q', false), 422, 'PROVIDER_UNSUPPORTED_REGION', false],
    [new PolicyError('VALIDATION_FAILED', 'secret detail', false), 422, 'VALIDATION_FAILED', false],
  ])('maps %s', async (err, status, code, retryable) => {
    const r = await fire(miniApp({ find: async () => { throw err; } }));
    expect(r.statusCode).toBe(status);
    const e = ApiError.parse(r.json());
    expect(e).toMatchObject({ code, retryable });
    expect(r.payload).not.toMatch(/secret detail/);
  });

  it('a cancelled request closes the socket instead of leaving an unsent reply', async () => {
    const app = miniApp({ find: async () => { throw new PolicyError('CANCELLED', 'c', false); } });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const outcome = await fetch(`http://127.0.0.1:${port}/api/v1/planning-context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ area: 'x', transportMode: 'transit' }) }).then(
      r => `status ${r.status}`,
      () => 'closed',
    );
    expect(outcome).toBe('closed');
  });

  it('a second concurrent request of the same user is refused, and the daily cap holds', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => (release = res));
    const app = miniApp({ find: async () => { await gate; return { places: [], reason: 'no_results' as const }; } });
    const first = fire(app);
    await new Promise(r => setTimeout(r, 20));
    const second = await fire(app);
    expect(second.statusCode).toBe(429);
    expect(ApiError.parse(second.json()).code).toBe('RATE_LIMITED');
    release();
    expect((await first).statusCode).toBe(200);

    const l = createUserLimiter({ perDay: 2 });
    for (let i = 0; i < 2; i++) (l.acquire('u') as () => void)();
    expect(l.acquire('u')).toBe('daily');
    expect(typeof l.acquire('other')).toBe('function');
  });

  it('stops without a reply body error when the call budget limit is exhausted (rate limit, not retryable)', async () => {
    const budget = new CallBudget({ maxCalls: 0, quota: new DailyQuota({}), gate: new Gate(1) });
    await expect(budget.run('x', 'k', async () => 1)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
  });
});

describe('K05 legs queries, mixed/live modes and startup config (fake fetch only)', () => {
  const OK_ENV = { SESSION_SECRET: 's'.repeat(40) };
  const q = (over: object = {}) => ({ fromPlaceId: 'fx_kanazawa_station', toPlaceId: 'fx_kenrokuen', departureUtc: '2026-11-01T00:00:00Z', mode: 'transit', ...over });
  const miniWith = (sources: ContextSources) => {
    const app = Fastify({ logger: false });
    app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'u1', displayName: 'U' }));
    registerPlanningContext(app, { providerMode: sources.mode } as never, { sources, limiter: createUserLimiter({ perDay: 50 }) });
    apps.push(app);
    return (payload: object) => app.inject({ method: 'POST', url: '/api/v1/planning-context', payload });
  };

  it('fixture mode answers a legs query with only the segments asked for', async () => {
    const post = miniWith(createContextSources({ providerMode: 'fixture' }));
    const r = await post({ area: '金沢', transportMode: 'transit', legs: [q(), q({ toPlaceId: 'fx_ghost' })] });
    const c = PlanningContext.parse(r.json());
    expect(c.legs.map(l => l.legId)).toEqual(['fx_leg_1']);
    expect(c.unknown).toContain('legs'); // the ghost segment is unknown, not invented
    expect(c.places.map(p => p.placeId)).toEqual(expect.arrayContaining(['fx_kanazawa_station', 'fx_kenrokuen']));
  });

  it('mixed mode: fixture places, no route call without a legs query, then one fake Routes call per asked segment', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ routes: [{ duration: '600s', distanceMeters: 3000 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'test-key' }, { fetch: fakeFetch });
    const post = miniWith(sources);
    const first = PlanningContext.parse((await post({ area: '金沢', transportMode: 'car', timeZone: 'Asia/Tokyo' })).json());
    expect(urls).toHaveLength(0);
    expect(first).toMatchObject({ dataMode: 'mixed', legs: [] });
    expect(first.unknown).toContain('legs');
    expect(first.places.every(p => p.provenance.source === 'fixture')).toBe(true);

    const second = PlanningContext.parse((await post({ area: '金沢', transportMode: 'car', legs: [q({ mode: 'car' }), q({ mode: 'car', fromPlaceId: 'fx_kenrokuen', toPlaceId: 'fx_sushi' })] })).json());
    expect(urls).toHaveLength(2);
    expect(second.legs).toHaveLength(2);
    expect(second.legs[0]).toMatchObject({ durationSeconds: 600, provenance: { source: 'google_routes', mayStore: false, maySendToModel: false } });
    expect(second.dataMode).toBe('mixed');
  });

  it('mixed/live need a key, and the live place search needs a time zone and maps provider limits', async () => {
    expect(() => createContextSources({ providerMode: 'mixed' }, {})).toThrow(/GOOGLE_MAPS_SERVER_KEY/);
    const { GoogleAreaPlaceSource } = await import('../src/trips/generation/sources.ts');
    const budget = new CallBudget({ maxCalls: 1, quota: new DailyQuota({}), gate: new Gate(1) });
    const limited = new GoogleAreaPlaceSource({ searchText: async () => ({ places: [], reason: 'rate_limited', dropped: 0 }), searchNearby: async () => ({ places: [], reason: null, dropped: 0 }) });
    await expect(limited.find({ area: 'x', maxPlaces: 4, placeIds: [] }, budget)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(limited.find({ area: 'x', maxPlaces: 4, placeIds: [], timeZone: 'Asia/Tokyo' }, budget)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT', retryable: false });
    const empty = new GoogleAreaPlaceSource({ searchText: async () => ({ places: [], reason: 'no_results', dropped: 0 }), searchNearby: async () => ({ places: [], reason: null, dropped: 0 }) });
    expect(await empty.find({ area: 'x', maxPlaces: 4, placeIds: [], timeZone: 'Asia/Tokyo' }, budget)).toEqual({ places: [], reason: 'no_results' });
  });

  it('startup config: mixed/live refuse without a key, unknown modes and invalid limits are refused, capabilities report the real mode', async () => {
    expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: 'mixed' })).toThrow(/PROVIDER_MODE=mixed requires GOOGLE_MAPS_SERVER_KEY/);
    expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: 'live', GOOGLE_MAPS_SERVER_KEY: '  ' })).toThrow(/GOOGLE_MAPS_SERVER_KEY/);
    expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: 'LIVE', GOOGLE_MAPS_SERVER_KEY: 'k' })).toThrow(/PROVIDER_MODE/);
    expect(() => loadConfig({ ...OK_ENV, TRAVEL_MAX_CALLS_PER_INPUT: '99' })).toThrow(/safe default/);
    for (const bad of ['0', '-1', '1001', 'abc', '1.5']) expect(() => loadConfig({ ...OK_ENV, PLANNING_CONTEXT_DAILY_PER_USER: bad }), bad).toThrow(/PLANNING_CONTEXT_DAILY_PER_USER/);
    expect(() => loadConfig({ ...OK_ENV, PLANNING_CONTEXT_DAILY_PER_USER: '1000' })).not.toThrow();
    expect(loadConfig({ ...OK_ENV }).providerMode).toBe('fixture');
    const cfg = loadConfig({ ...OK_ENV, PROVIDER_MODE: 'mixed', GOOGLE_MAPS_SERVER_KEY: 'test-key' });
    expect(JSON.stringify(cfg)).not.toContain('test-key'); // the key is never kept in the config
    const db = openDatabase(':memory:');
    migrate(db);
    vi.stubEnv('GOOGLE_MAPS_SERVER_KEY', 'test-key'); // the app reads the key from the environment; no call is made here
    const app = buildApp({ config: { ...cfg, databasePath: ':memory:' }, db });
    vi.unstubAllEnvs();
    apps.push(app);
    expect((await app.inject('/api/v1/capabilities')).json().dataMode).toBe('mixed');
  });
});
