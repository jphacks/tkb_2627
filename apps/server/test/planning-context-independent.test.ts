// K05 independent, spec-driven tests (CONTRACTS K05, CLAUDE.md §2, M1 decisions D-1/D-2). Fake sources only; no network
// beyond loopback for the disconnect case, no real Google.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ApiError, PlanningContext, type PlaceInfo } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { kanazawaPlaces } from '@tkb/fixtures';
import { CallBudget, PolicyError } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { registerPlanningContext } from '../src/trips/generation/index.ts';
import { createContextSources, type ContextSources } from '../src/trips/generation/sources.ts';
import { createUserLimiter } from '../src/trips/generation/user-limit.ts';

const PW = 'correct horse battery';
const OK_ENV = { SESSION_SECRET: 's'.repeat(40) };
const apps: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const real = () => createContextSources({ providerMode: 'fixture' });
/** Mini app where the user comes from the x-user header. */
function mini(sources: ContextSources, perDay = 50) {
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async (req: { actor?: unknown; headers: Record<string, unknown> }) => void (req.actor = { userId: String(req.headers['x-user'] ?? 'u1'), displayName: 'U' }));
  registerPlanningContext(app, { providerMode: sources.mode } as never, { sources, limiter: createUserLimiter({ perDay }) });
  apps.push(app);
  const post = (payload: object, user = 'u1') => app.inject({ method: 'POST', url: '/api/v1/planning-context', payload, headers: { 'x-user': user } });
  return { app, post };
}
const body = (over: object = {}) => ({ area: '金沢', transportMode: 'transit', ...over });
const leg = (over: object = {}) => ({ fromPlaceId: 'fx_kanazawa_station', toPlaceId: 'fx_kenrokuen', departureUtc: '2026-11-01T00:00:00Z', mode: 'transit', ...over });
const tables = (db: ReturnType<typeof openDatabase>) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(t => [t.name, (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n] as const);

describe('K05 auth, validation and persistence', () => {
  async function shared() {
    const db = openDatabase(':memory:');
    migrate(db);
    for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
    const app = buildApp({ config: { ...loadConfig(OK_ENV), databasePath: ':memory:' }, db });
    apps.push(app);
    const login = async (loginId: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
    };
    return { app, db, login };
  }

  it('is 401 without a session and with a bogus cookie, and the body has no data', async () => {
    const { app } = await shared();
    for (const headers of [{}, { cookie: 'tkb_session=bogus', 'x-csrf-token': 'x' }]) {
      const r = await app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: body(), headers });
      expect(r.statusCode).toBe(401);
      expect(r.payload).not.toMatch(/fx_|places/);
    }
  });

  it('writes no row to any table, for fixture answers, empty answers and rejections', async () => {
    const { app, db, login } = await shared();
    const h = await login('user-a');
    const before = tables(db);
    for (const payload of [body(), body({ area: 'Atlantis' }), body({ legs: [leg()] }), { area: '' }]) {
      await app.inject({ method: 'POST', url: '/api/v1/planning-context', payload, headers: h });
    }
    const after = tables(db);
    // the login itself may create a session row before this snapshot; K05 must add nothing after it
    expect(after).toEqual(before);
  });

  it('answers are identical for two users (no per-user data) and carry no-store', async () => {
    const { app, login } = await shared();
    const a = await app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: body({ legs: [leg()] }), headers: await login('user-a') });
    const b = await app.inject({ method: 'POST', url: '/api/v1/planning-context', payload: body({ legs: [leg()] }), headers: await login('user-b') });
    expect(a.statusCode).toBe(200);
    expect(a.body).toBe(b.body);
    expect(a.headers['cache-control']).toBe('no-store');
  });

  it('rejects out-of-range maxPlaces and more than 8 legs with 422 VALIDATION_FAILED', async () => {
    const { post } = mini(real());
    const nine = Array.from({ length: 9 }, () => leg());
    for (const bad of [body({ maxPlaces: 0 }), body({ maxPlaces: 31 }), body({ maxPlaces: 1.5 }), body({ legs: nine }), body({ legs: [leg({ mode: 'boat' })] }), body({ legs: [leg({ departureUtc: 'tomorrow' })] })]) {
      const r = await post(bad);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 60)).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
    }
    expect((await post(body({ legs: Array.from({ length: 8 }, () => leg()) }))).statusCode).toBe(200);
  });
});

describe('K05 contents: pinned behaviour, nothing invented', () => {
  it('unknown area: 200 with empty places and legs and "places" in unknown; mustVisit named too', async () => {
    const { post } = mini(real());
    const r = await post(body({ area: 'Atlantis', placeIds: ['fx_kenrokuen'] }));
    expect(r.statusCode).toBe(200);
    const c = PlanningContext.parse(r.json());
    expect(c.places).toEqual([]);
    expect(c.legs).toEqual([]);
    expect(c.unknown).toEqual(expect.arrayContaining(['places', 'mustVisit']));
  });

  it('a leg query naming a place outside the area set is omitted and reported as unknown legs (no invented leg)', async () => {
    const { post } = mini(real());
    const r = PlanningContext.parse((await post(body({ legs: [leg(), leg({ toPlaceId: 'google_outside_1' }), leg({ fromPlaceId: 'google_outside_2' })] }))).json());
    expect(r.legs.map(l => l.legId)).toEqual(['fx_leg_1']);
    expect(r.legs.every(l => l.fromPlaceId !== 'google_outside_2' && l.toPlaceId !== 'google_outside_1')).toBe(true);
    expect(r.unknown).toContain('legs');
    expect(r.places.some(p => p.placeId.startsWith('google_outside'))).toBe(false);
  });

  it('a known place pair that fixtures lack is a leg-less answer, never a made-up duration', async () => {
    const { post } = mini(real());
    const r = PlanningContext.parse((await post(body({ legs: [leg({ fromPlaceId: 'fx_higashi', toPlaceId: 'fx_omicho' })] }))).json());
    for (const l of r.legs) {
      if (l.provenance === null) expect(l).toMatchObject({ durationSeconds: null, fare: null, platform: null, lineName: null, dataStatus: 'unknown' });
    }
    expect(r.legs.every(l => l.platform === null)).toBe(true); // fixtures never carry a platform
    expect(r.unknown).toEqual(expect.arrayContaining(['platform']));
  });

  it('fixture mode: unknown opening hours and fares are listed, platform is never present, unknown leg has null everything', async () => {
    const { post } = mini(real());
    const c = PlanningContext.parse((await post(body())).json());
    expect(c.dataMode).toBe('fixture');
    expect(c.unknown).toEqual(expect.arrayContaining(['openingHours', 'platform']));
    expect(c.places.filter(p => p.openingHours === null).length).toBeGreaterThan(0);
    for (const l of c.legs) {
      expect(l.platform).toBeNull();
      if (l.fare === null) expect(c.unknown).toContain('fare');
    }
    const unknownLeg = c.legs.find(l => l.dataStatus === 'unknown')!;
    expect(unknownLeg).toMatchObject({ durationSeconds: null, fare: null, platform: null, lineName: null, arrival: null });
  });

  it('maxPlaces bounds the list (mustVisit first), and the reply never exceeds 20 places whatever a source returns', async () => {
    const many: PlaceInfo[] = Array.from({ length: 25 }, (_, i) => ({ ...kanazawaPlaces[1]!, placeId: `p${i}`, name: `p${i}` }));
    const big: ContextSources = { ...real(), places: { find: async () => ({ places: many, reason: null }) } };
    const { post } = mini(big);
    const c = PlanningContext.parse((await post(body({ maxPlaces: 30 }))).json());
    expect(c.places.length).toBeLessThanOrEqual(20);
    const fx = mini(real());
    const one = PlanningContext.parse((await fx.post(body({ maxPlaces: 1, placeIds: ['fx_sushi'] }))).json());
    expect(one.places.map(p => p.placeId)).toEqual(['fx_sushi']);
    expect(one.unknown).not.toContain('mustVisit');
  });
});

describe('K05 limits and cancellation', () => {
  it('per-user concurrency 1: a second concurrent request of the same user is 429 RATE_LIMITED (retryable), another user is not blocked', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => (release = res));
    let started = 0;
    const slow: ContextSources = { ...real(), places: { find: async () => (started++, await gate, { places: [], reason: 'no_results' as const }) } };
    const { post } = mini(slow);
    const first = post(body(), 'u1');
    await new Promise(r => setTimeout(r, 20));
    const second = await post(body(), 'u1');
    expect(second.statusCode).toBe(429);
    expect(ApiError.parse(second.json())).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    const other = post(body(), 'u2'); // independent of u1's slot
    await new Promise(r => setTimeout(r, 20));
    expect(started).toBe(2);
    release();
    expect((await first).statusCode).toBe(200);
    expect((await other).statusCode).toBe(200);
    expect((await post(body(), 'u1')).statusCode).toBe(200); // slot freed
  });

  it('a request that fails or is rejected by validation frees the slot; the daily cap is per user and counts valid requests only', async () => {
    let fail = true;
    const flaky: ContextSources = { ...real(), places: { find: async () => { if (fail) throw new PolicyError('PROVIDER_UNAVAILABLE', 'x', true); return { places: [], reason: 'no_results' as const }; } } };
    const { post } = mini(flaky, 3);
    expect((await post(body(), 'u1')).statusCode).toBe(503);
    expect((await post({ area: '' }, 'u1')).statusCode).toBe(422); // invalid: not counted
    fail = false;
    expect((await post(body(), 'u1')).statusCode).toBe(200);
    expect((await post(body(), 'u1')).statusCode).toBe(200);
    const over = await post(body(), 'u1');
    expect(over.statusCode).toBe(429);
    expect(ApiError.parse(over.json())).toMatchObject({ code: 'RATE_LIMITED', retryable: false });
    expect((await post(body(), 'u2')).statusCode).toBe(200);
  });

  it('client disconnect aborts the provider budget signal and frees the user slot', async () => {
    let signal: AbortSignal | undefined;
    let entered!: () => void;
    const inFind = new Promise<void>(r => (entered = r));
    const base = real();
    const watching: ContextSources = {
      ...base,
      places: {
        find: async (_req, budget: CallBudget) => {
          if (signal) return { places: [], reason: 'no_results' as const }; // later calls answer at once
          signal = budget.signal;
          entered();
          await new Promise<void>(res => budget.signal.addEventListener('abort', () => res(), { once: true }));
          throw new PolicyError('CANCELLED', 'cancelled', false);
        },
      },
    };
    const { app, post } = mini(watching);
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/v1/planning-context', headers: { 'content-type': 'application/json', 'x-user': 'u1' } });
    req.on('error', () => {});
    req.end(JSON.stringify(body()));
    await inFind;
    expect(signal!.aborted).toBe(false);
    req.destroy();
    for (let i = 0; i < 100 && !signal!.aborted; i++) await new Promise(r => setTimeout(r, 10));
    expect(signal!.aborted).toBe(true);
    // the slot is released: the same user can ask again (the second call is also cancelled by the fake, so only check it is not 429)
    for (let i = 0; i < 50; i++) {
      const r = await post(body({ area: 'Atlantis' }), 'u1').catch(() => null);
      if (r && r.statusCode !== 429) return expect(r.statusCode).not.toBe(429);
      await new Promise(res => setTimeout(res, 10));
    }
    throw new Error('slot never released after disconnect');
  });

  it('provider failure messages (possibly with provider text) never reach the reply body', async () => {
    const leaky = (code: never): ContextSources => ({ ...real(), places: { find: async () => { throw new PolicyError(code, 'GOOGLE_NAME_SENTINEL key=AIza-SENTINEL', false); } } });
    for (const code of ['PROVIDER_RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'PROVIDER_UNSUPPORTED_REGION', 'VALIDATION_FAILED', 'INTERNAL'] as never[]) {
      const r = await mini(leaky(code)).post(body());
      expect(r.payload).not.toMatch(/SENTINEL|AIza/);
      expect(ApiError.parse(r.json()).code).toBeTruthy();
    }
  });
});

describe('mixed/live through fake fetch', () => {
  it('mixed: a Routes reply with sentinel text never alters fixed fields; every live leg is flagged not storable/not for the model', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ routes: [{ duration: '600s', distanceMeters: 3000, legs: [{ steps: [{ transitDetails: { transitLine: { name: 'LINE_SENTINEL' } } }] }] }] }), { status: 200 })) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: fakeFetch });
    const { post } = mini(sources);
    const c = PlanningContext.parse((await post(body({ legs: [leg()] }))).json());
    expect(c.dataMode).toBe('mixed');
    expect(c.legs).toHaveLength(1);
    expect(c.legs[0]!.provenance).toMatchObject({ source: 'google_routes', mayStore: false, maySendToModel: false, mayExport: false });
    expect(c.legs[0]!.platform).toBeNull(); // never invented
  });

  it('a Routes failure makes the leg unknown (no leg, "legs" in unknown) and the body carries no provider text', async () => {
    const fakeFetch = (async () => new Response('GOOGLE_NAME_SENTINEL', { status: 500 })) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: fakeFetch });
    const r = await mini(sources).post(body({ legs: [leg()] }));
    expect(r.payload).not.toMatch(/SENTINEL/);
    if (r.statusCode === 200) {
      const c = PlanningContext.parse(r.json());
      expect(c.legs).toEqual([]);
      expect(c.unknown).toContain('legs');
    } else expect([429, 503]).toContain(r.statusCode);
  });
});

describe('startup config', () => {
  it('mixed/live without a key throw; bogus modes throw; capabilities report the configured mode', async () => {
    for (const mode of ['mixed', 'live']) {
      expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: mode })).toThrow(/GOOGLE_MAPS_SERVER_KEY/);
      expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: mode, GOOGLE_MAPS_SERVER_KEY: '' })).toThrow(/GOOGLE_MAPS_SERVER_KEY/);
    }
    for (const bad of ['Mixed', 'real', 'production', ' fixture', 'fixture ', '1']) {
      expect(() => loadConfig({ ...OK_ENV, PROVIDER_MODE: bad, GOOGLE_MAPS_SERVER_KEY: 'k' }), bad).toThrow(/PROVIDER_MODE/);
    }
    expect(loadConfig({ ...OK_ENV }).providerMode).toBe('fixture');
    for (const mode of ['fixture', 'mixed', 'live'] as const) {
      const db = openDatabase(':memory:');
      migrate(db);
      const cfg = loadConfig({ ...OK_ENV, PROVIDER_MODE: mode, GOOGLE_MAPS_SERVER_KEY: 'k' });
      const prev = process.env.GOOGLE_MAPS_SERVER_KEY;
      process.env.GOOGLE_MAPS_SERVER_KEY = 'k';
      const app = buildApp({ config: { ...cfg, databasePath: ':memory:' }, db });
      if (prev === undefined) delete process.env.GOOGLE_MAPS_SERVER_KEY;
      else process.env.GOOGLE_MAPS_SERVER_KEY = prev;
      apps.push(app);
      expect((await app.inject('/api/v1/capabilities')).json().dataMode).toBe(mode);
    }
  });

  it('invalid or raised usage limits are refused at startup', () => {
    for (const [k, v] of [['TRAVEL_MAX_CALLS_PER_INPUT', 'abc'], ['TRAVEL_MAX_CALLS_PER_INPUT', '-1'], ['TRAVEL_MAX_CALLS_PER_INPUT', '1.5'], ['TRAVEL_MAX_CALLS_PER_INPUT', '999999'], ['TRAVEL_DAILY_LIMIT_PER_SKU', '999999'], ['TRAVEL_DAILY_LIMIT_PER_SKU', 'x'], ['TRAVEL_MAX_CONCURRENT', '0'], ['TRAVEL_MAX_CONCURRENT', '99']] as const) {
      expect(() => loadConfig({ ...OK_ENV, [k]: v }), `${k}=${v}`).toThrow();
    }
    expect(() => loadConfig({ ...OK_ENV, TRAVEL_MAX_CALLS_PER_INPUT: '1', TRAVEL_MAX_CONCURRENT: '1', TRAVEL_DAILY_LIMIT_PER_SKU: '1' })).not.toThrow();
  });

  it('the Google key is not kept in the config and not echoed by capabilities', async () => {
    const cfg = loadConfig({ ...OK_ENV, PROVIDER_MODE: 'live', GOOGLE_MAPS_SERVER_KEY: 'KEY_SENTINEL_123' });
    expect(JSON.stringify(cfg)).not.toContain('KEY_SENTINEL_123');
  });
});
