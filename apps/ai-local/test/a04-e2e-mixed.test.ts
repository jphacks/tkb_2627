// A04 end to end in PROVIDER_MODE=mixed: fixture places, "live" Routes through a FAKE Google fetch with sentinel values.
// Real shared server (in-memory DB) + personal app bridged in process. No network, no real Google, no real CLI.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '@tkb/ai';
import { JobStatus, PlanCandidate, type GenerationInput, type TripConstraints } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp as buildShared } from '../../server/src/platform/app.ts';
import { hashPassword } from '../../server/src/platform/auth/password.ts';
import { loadConfig as loadShared } from '../../server/src/platform/config.ts';
import { buildApp as buildLocal } from '../src/app.ts';
import { PairingStore } from '../src/auth/pairing.ts';
import { loadConfig as loadLocal } from '../src/config.ts';
import type { FetchLike } from '../src/shared-client/index.ts';

const PW = 'correct horse battery';
const HOST = '127.0.0.1:4311';
const ORIGIN = 'http://127.0.0.1:4311';
const closers: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});

const day = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10); // inside the Routes transit window
const constraints: TripConstraints = {
  area: '金沢', startDate: day, endDate: day, timeZone: 'Asia/Tokyo', transportMode: 'car', mustVisit: ['fx_kenrokuen'],
  departure: { placeId: 'fx_kanazawa_station', label: null, time: null },
};
const FIVE = ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi', 'fx_sushi'];
const rot = (n: number) => [...FIVE.slice(n), ...FIVE.slice(0, n)];
const blueprint = {
  schemaVersion: 1,
  candidates: [FIVE, [...FIVE].reverse(), rot(2)].map((order, i) => ({ candidateId: `c${i + 1}`, title: `案${i + 1}`, activityOrder: order, reasons: [], warnings: [] })),
};
function capturingRunner() {
  const r = {
    inputs: [] as GenerationInput[],
    run: async (input: GenerationInput) => {
      r.inputs.push(input);
      return { exitCode: 0, envelope: { type: 'result', subtype: 'success', is_error: false, structured_output: blueprint }, durationMs: 1 };
    },
  };
  return r satisfies Runner;
}

/** The fake Google Routes endpoint: every answer is full of sentinels that must never be stored or sent to the model. */
function fakeGoogle() {
  const calls: string[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    const body = JSON.parse(String(init?.body)) as { travelMode: string };
    const route =
      body.travelMode === 'TRANSIT'
        ? {
            duration: '2222s',
            distanceMeters: 4000,
            legs: [{ steps: [{ travelMode: 'TRANSIT', staticDuration: '1800s', transitDetails: { stopDetails: { departureStop: { name: 'SENTINEL-STOP' } }, transitLine: { name: 'SENTINEL-LINE-NAME', nameShort: 'SENTINEL-LINE' } } }] }],
            travelAdvisory: { transitFare: { currencyCode: 'JPY', units: '777' } },
          }
        : { duration: '600s', distanceMeters: 500 };
    return new Response(JSON.stringify({ routes: [route] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fn };
}

function mixedServer(google: typeof fetch) {
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: pwHash, displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  // buildApp has no dependency parameter, so the key comes from the environment and the Routes adapter picks up the
  // global fetch while it is built; both are restored right away.
  vi.stubEnv('GOOGLE_MAPS_SERVER_KEY', 'test-key-not-real');
  vi.stubGlobal('fetch', google);
  let app: ReturnType<typeof buildShared>;
  try {
    const config = { ...loadShared({ SESSION_SECRET: 's'.repeat(40), PROVIDER_MODE: 'mixed', GOOGLE_MAPS_SERVER_KEY: 'test-key-not-real' }), databasePath: ':memory:' };
    app = buildShared({ config, db });
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
  closers.push(app);
  return { app, db };
}

const bridge = (server: ReturnType<typeof mixedServer>['app']): FetchLike => async (url, init) => {
  const u = new URL(url);
  const res = await server.inject({ method: init.method as 'GET' | 'POST', url: u.pathname + u.search, payload: init.body as string | undefined, headers: init.headers as Record<string, string> });
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else if (v !== undefined) h.set(k, String(v));
  }
  return new Response(res.body, { status: res.statusCode, headers: h });
};

describe('A04 end to end, PROVIDER_MODE=mixed', () => {
  it('stores no live route detail, sends the model no live data, and spends at most 6 Routes calls for 3 candidates x 5 stops', async () => {
    const google = fakeGoogle();
    const { app: server, db } = mixedServer(google.fn);
    const runner = capturingRunner();
    const config = { ...loadLocal({ PERSONAL_OWNER_USER_ID: 'user_a' }), jobDir: null };
    const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
    const app = buildLocal({ config, pairing, runner, fetch: bridge(server) });
    closers.push(app);

    const pr = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
    const h = { host: HOST, origin: ORIGIN, cookie: String(pr.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (pr.json() as { csrfToken: string }).csrfToken };
    expect((await app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: h })).statusCode).toBe(200);
    const g = await app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': 'key-mixed-0001' } });
    expect(g.statusCode).toBe(202);
    let job = JobStatus.parse((await app.inject({ url: `/local/v1/jobs/${g.json().jobId}`, headers: h })).json());
    for (let i = 0; i < 300 && !['succeeded', 'failed', 'cancelled'].includes(job.state); i++) {
      await new Promise(r => setTimeout(r, 10));
      job = JobStatus.parse((await app.inject({ url: `/local/v1/jobs/${g.json().jobId}`, headers: h })).json());
    }
    expect(job).toMatchObject({ state: 'succeeded', stage: 'done' });
    expect(job.batchId).not.toBeNull();

    // Routes: at most 6 for the whole job, and the model was never given live data.
    expect(google.calls.length).toBeGreaterThan(0);
    expect(google.calls.length).toBeLessThanOrEqual(6);
    expect(google.calls.every(u => u.startsWith('https://routes.googleapis.com/'))).toBe(true);
    expect(runner.inputs).toHaveLength(1);
    const given = runner.inputs[0]!;
    expect(JSON.stringify(given)).not.toMatch(/SENTINEL|777|2222/);
    expect(given.facts.every(f => (f.kind === 'place' ? f.place.provenance.source === 'fixture' && f.place.provenance.maySendToModel : f.leg.provenance === null || f.leg.provenance.maySendToModel))).toBe(true);
    expect(given.facts.some(f => f.kind === 'leg' && f.leg.provenance?.source === 'google_routes')).toBe(false);
    expect([...given.allowedPlaceIds].sort()).toEqual([...FIVE].sort());

    // The persisted row: computed times yes, live route details no.
    const row = db.prepare('SELECT id, candidates_json, places_json FROM plan_batches').get() as { id: string; candidates_json: string; places_json: string };
    expect(row.id).toBe(job.batchId);
    expect(`${row.candidates_json}${row.places_json}`).not.toMatch(/SENTINEL|"amountMinor":777|2222|"lineName":"[^"]/);
    const candidates = (JSON.parse(row.candidates_json) as unknown[]).map(c => PlanCandidate.parse(c));
    expect(candidates).toHaveLength(3);
    const items = candidates.flatMap(c => c.days.flatMap(d => d.items));
    const legs = items.filter(i => i.type === 'leg');
    expect(legs.length).toBeGreaterThan(0);
    for (const l of legs) {
      expect(l).toMatchObject({ durationSeconds: null, fare: null, lineName: null, platform: null, transfers: null, departure: null, arrival: null });
      expect(l.provenance?.source).toBe('google_routes');
    }
    expect(items.some(i => i.type === 'activity' && i.start !== null)).toBe(true); // schedule times computed from the live durations are kept
    for (const c of candidates) {
      if (c.days.some(d => d.items.some(i => i.type === 'leg'))) expect(c.warnings).toContain('移動情報は表示時に再取得');
      expect(c.validationState).not.toBe('valid');
    }
    // 3 candidates x 5 stops need more than 6 pairs; those beyond the cap are untimed and say so.
    expect(candidates.some(c => c.warnings.some(w => w.includes('移動時間不明')))).toBe(true);
  });
});
