// I02 (CI part): K01 generation -> K07 save -> K08 fetch through the real modules, in process.
// Real shared server (in-memory DB, PROVIDER_MODE=fixture) + real personal app, bridged without a network.
// The runner is a FAKE that returns a blueprint; no real Claude, no provider call. The live run is live-run.mts (manual).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeRunner, type Runner } from '@tkb/ai';
import { ApiError, JobStatus, PlanBatch, type GenerationInput, type TripConstraints } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { kanazawaPlaces } from '@tkb/fixtures';
import { buildApp as buildShared } from '../../../apps/server/src/platform/app.ts';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { loadConfig as loadShared } from '../../../apps/server/src/platform/config.ts';
import { buildApp as buildLocal } from '../../../apps/ai-local/src/app.ts';
import { PairingStore } from '../../../apps/ai-local/src/auth/pairing.ts';
import { loadConfig as loadLocal } from '../../../apps/ai-local/src/config.ts';
import type { FetchLike } from '../../../apps/ai-local/src/shared-client/index.ts';

const PW = 'correct horse battery';
const HOST = '127.0.0.1:4311';
const ORIGIN = 'http://127.0.0.1:4311';
const KNOWN = new Set(kanazawaPlaces.map(p => p.placeId));
const closers: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});

const kanazawa: TripConstraints = {
  area: '金沢',
  startDate: '2026-11-01',
  endDate: '2026-11-02',
  timeZone: 'Asia/Tokyo',
  transportMode: 'transit',
  mustVisit: ['fx_kenrokuen'],
  departure: { placeId: 'fx_kanazawa_station', label: null, time: null },
};
// An area the fixtures do not cover ("取得不可地域").
const nowhere: TripConstraints = { area: '存在しない町', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };

const blueprint = {
  schemaVersion: 1,
  candidates: [
    { candidateId: 'c1', title: '兼六園と美術館', activityOrder: ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho'], reasons: ['定番を無理なく回る'], warnings: [] },
    { candidateId: 'c2', title: '茶屋街とお寿司', activityOrder: ['fx_kenrokuen', 'fx_higashi', 'fx_sushi'], reasons: ['食事重視'], warnings: [] },
  ],
};
function fakeModel(output: unknown): Runner & { calls: number; inputs: GenerationInput[] } {
  const r = {
    calls: 0,
    inputs: [] as GenerationInput[],
    run: async (input: GenerationInput) => {
      r.calls++;
      r.inputs.push(input);
      return { exitCode: 0, envelope: { type: 'result', subtype: 'success', is_error: false, structured_output: output }, durationMs: 1 };
    },
  };
  return r;
}

function sharedServer() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
  const app = buildShared({ config: { ...loadShared({ SESSION_SECRET: 's'.repeat(40), PROVIDER_MODE: 'fixture' }), databasePath: ':memory:' }, db });
  closers.push(app);
  return { app, db };
}
type Server = ReturnType<typeof sharedServer>['app'];

const bridge = (server: Server): FetchLike => async (url, init) => {
  const u = new URL(url);
  const res = await server.inject({ method: init.method as 'GET' | 'POST', url: u.pathname + u.search, payload: init.body as string | undefined, headers: init.headers as Record<string, string> });
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else if (v !== undefined) h.set(k, String(v));
  }
  return new Response(res.body, { status: res.statusCode, headers: h });
};

async function setup(runner: Runner) {
  const shared = sharedServer();
  const config = { ...loadLocal({ PERSONAL_OWNER_USER_ID: 'user_a' }), jobDir: null };
  const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
  const app = buildLocal({ config, pairing, runner, fetch: bridge(shared.app) });
  closers.push(app);
  const pr = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
  expect(pr.statusCode).toBe(200);
  const h = { host: HOST, origin: ORIGIN, cookie: String(pr.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (pr.json() as { csrfToken: string }).csrfToken };
  const lr = await app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: h });
  expect(lr.statusCode).toBe(200);
  const generate = (constraints: TripConstraints, key: string) =>
    app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': key } });
  const settle = async (jobId: string) => {
    for (let i = 0; i < 300; i++) {
      const s = JobStatus.parse((await app.inject({ url: `/local/v1/jobs/${jobId}`, headers: h })).json());
      if (s.state === 'succeeded' || s.state === 'failed' || s.state === 'cancelled') return s;
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('job did not settle');
  };
  const app_shared = shared.app;
  const app_shared_get = async (batchId: string) => app_shared.inject({ url: `/api/v1/plan-batches/${batchId}`, headers: await sharedLogin(app_shared, 'user-a') });
  return { db: shared.db, app, app_shared, app_shared_get, generate, settle };
}
async function sharedLogin(server: Server, loginId: string) {
  const r = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
}
const batchCount = (db: ReturnType<typeof sharedServer>['db']) => (db.prepare('SELECT COUNT(*) AS n FROM plan_batches').get() as { n: number }).n;

describe('I02 generation end to end (fixture data, fake model)', () => {
  it('(a) 金沢: K01 -> job succeeded -> K07 batch saved -> K08 read back, honestly labelled', async () => {
    const s = await setup(fakeModel(blueprint));
    const g = await s.generate(kanazawa, 'key-i02-0001');
    expect(g.statusCode).toBe(202);
    const job = await s.settle(g.json().jobId);
    expect(job).toMatchObject({ state: 'succeeded', stage: 'done', error: null });
    expect(job.batchId).not.toBeNull();

    const res = await s.app_shared_get(job.batchId!);
    expect(res.statusCode).toBe(200);
    const batch = PlanBatch.parse(res.json());
    expect(batch.candidates.length).toBeGreaterThanOrEqual(1);
    expect(batch.candidates.length).toBeLessThanOrEqual(3);

    // Data labels: fixture data is never 'verified'.
    expect(batch.places.length).toBeGreaterThan(0);
    for (const p of batch.places) {
      expect(KNOWN.has(p.placeId)).toBe(true);
      expect(p.dataStatus).not.toBe('verified');
      expect(p.provenance.source).toBe('fixture');
    }
    for (const c of batch.candidates) {
      expect(c.validationState).not.toBe('valid'); // fixture data cannot make a plan "valid"
      expect(c.warnings.length).toBeGreaterThan(0);
      expect(c.hasUnknownCost).toBe(true);
      for (const d of c.days) for (const it of d.items) {
        if (it.type === 'activity') {
          expect(it.placeId === null || KNOWN.has(it.placeId)).toBe(true);
          expect(it.costStatus).not.toBe('verified');
          if (it.cost === null) expect(it.costStatus).toBe('unknown'); // unknown cost is never invented
        } else {
          // No invented timetable details: unknown stays null.
          // Platform, transfers and clock times are never filled from fixtures; a fixture fare/line is allowed only when labelled fixture.
          expect(it).toMatchObject({ platform: null, transfers: null, departure: null, arrival: null });
          expect(it.dataStatus).not.toBe('verified');
          if (it.fare !== null || it.lineName !== null) {
            expect(it.dataStatus).toBe('fixture');
            expect(it.provenance?.source).toBe('fixture');
          }
        }
      }
    }
  });

  it('(a) ownership: another user gets 404 for the batch, the same answer as a missing one', async () => {
    const s = await setup(fakeModel(blueprint));
    const job = await s.settle((await s.generate(kanazawa, 'key-i02-0002')).json().jobId);
    expect(job.state).toBe('succeeded');
    const b = await sharedLogin(s.app_shared, 'user-b');
    const other = await s.app_shared.inject({ url: `/api/v1/plan-batches/${job.batchId}`, headers: b });
    const missing = await s.app_shared.inject({ url: '/api/v1/plan-batches/batch_nope', headers: b });
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect({ ...ApiError.parse(other.json()), requestId: '' }).toEqual({ ...ApiError.parse(missing.json()), requestId: '' });
    const own = await s.app_shared.inject({ url: `/api/v1/plan-batches/${job.batchId}`, headers: await sharedLogin(s.app_shared, 'user-a') });
    expect(own.statusCode).toBe(200);
  });

  it('(b) 取得不可地域: does not report success with fabricated content', async () => {
    const runner = fakeModel(blueprint);
    const s = await setup(runner);
    const g = await s.generate(nowhere, 'key-i02-0003');
    // Pinned to the observed honest outcome: accepted, then failed with CONSTRAINT_UNSATISFIED before any model run.
    expect(g.statusCode).toBe(202);
    const job = await s.settle(g.json().jobId);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('CONSTRAINT_UNSATISFIED');
    expect(runner.calls).toBe(0);
    expect(job.batchId).toBeNull();
    expect(batchCount(s.db)).toBe(0);
    // The model is never asked to plan an area for which no place facts exist.
    for (const input of runner.inputs) expect(input.allowedPlaceIds.length).toBeGreaterThan(0);
  });

  it('(c) the same Idempotency-Key returns the same job, and no second batch or model run', async () => {
    const runner = fakeModel(blueprint);
    const s = await setup(runner);
    const a = (await s.generate(kanazawa, 'key-i02-0004')).json().jobId as string;
    const first = await s.settle(a);
    const b = (await s.generate(kanazawa, 'key-i02-0004')).json().jobId as string;
    expect(b).toBe(a);
    expect(await s.settle(b)).toMatchObject({ state: 'succeeded', batchId: first.batchId });
    expect(runner.calls).toBe(1);
    expect(batchCount(s.db)).toBe(1);
  });

  it('(d) invalid model output: job failed, nothing saved', async () => {
    const s = await setup(fakeModel({ schemaVersion: 1, candidates: [{ candidateId: 'c1', title: 'x', activityOrder: ['made_up_place'], reasons: [], warnings: [] }] }));
    const job = await s.settle((await s.generate(kanazawa, 'key-i02-0005')).json().jobId);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBeTruthy();
    expect(job.batchId).toBeNull();
    expect(batchCount(s.db)).toBe(0);

    const garbage = await setup(fakeModel('not a blueprint'));
    const j2 = await garbage.settle((await garbage.generate(kanazawa, 'key-i02-0006')).json().jobId);
    expect(j2.state).toBe('failed');
    expect(batchCount(garbage.db)).toBe(0);
  });

  it('the stock FakeRunner (used when Claude is not enabled) cannot save invented content either', async () => {
    const s = await setup(new FakeRunner());
    const job = await s.settle((await s.generate(kanazawa, 'key-i02-0007')).json().jobId);
    if (job.state === 'succeeded') {
      const batch = PlanBatch.parse((await s.app_shared_get(job.batchId!)).json());
      expect(batch.places.every(p => KNOWN.has(p.placeId))).toBe(true);
    } else {
      expect(batchCount(s.db)).toBe(0);
    }
  });
});
