// A04 end to end in fixture mode: the real shared server (in-memory DB) and the personal app, bridged in process.
// The runner is a stand-in (never the real CLI); no network, no provider call.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Runner } from '@tkb/ai';
import { ApiError, PlanBatch, JobStatus, type TripConstraints } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { kanazawaPlaces } from '@tkb/fixtures';
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
const KNOWN = new Set(kanazawaPlaces.map(p => p.placeId));
const closers: { close(): Promise<unknown> }[] = [];
const dirs: string[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const constraints: TripConstraints = {
  area: '金沢',
  startDate: '2026-11-01',
  endDate: '2026-11-02',
  timeZone: 'Asia/Tokyo',
  transportMode: 'transit',
  mustVisit: ['fx_kenrokuen'],
  departure: { placeId: 'fx_kanazawa_station', label: null, time: null },
};

const blueprint = {
  schemaVersion: 1,
  candidates: [
    { candidateId: 'c1', title: '兼六園と美術館', activityOrder: ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho'], reasons: ['定番を無理なく回る'], warnings: [] },
    { candidateId: 'c2', title: '茶屋街とお寿司', activityOrder: ['fx_kenrokuen', 'fx_higashi', 'fx_sushi'], reasons: ['食事重視'], warnings: [] },
  ],
};
function standIn(): Runner & { calls: number } {
  const r = {
    calls: 0,
    run: async () => {
      r.calls++;
      return { exitCode: 0, envelope: { type: 'result', subtype: 'success', is_error: false, structured_output: blueprint }, durationMs: 1 };
    },
  };
  return r;
}

function sharedServer() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
  const app = buildShared({ config: { ...loadShared({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  closers.push(app);
  return { app, db };
}

type Server = ReturnType<typeof sharedServer>['app'];
/** fetch that goes to the in-process shared server instead of the network. */
const bridge = (server: Server, seen: string[] = [], hook?: (u: URL, init: RequestInit) => Promise<'drop-response' | 'hang' | null>): FetchLike => async (url, init) => {
  const u = new URL(url);
  seen.push(`${init.method} ${u.pathname}`);
  const mode = await hook?.(u, init);
  if (mode === 'hang') return new Promise<Response>(() => {});
  const res = await server.inject({ method: init.method as 'GET' | 'POST', url: u.pathname + u.search, payload: init.body as string | undefined, headers: init.headers as Record<string, string> });
  if (mode === 'drop-response') throw new Error('connection reset');
  const h = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach(x => h.append(k, x));
    else if (v !== undefined) h.set(k, String(v));
  }
  return new Response(res.body, { status: res.statusCode, headers: h });
};

function personal(server: Server, o: { runner: Runner; owner?: string; jobDir?: string; fetch?: FetchLike }) {
  const config = { ...loadLocal({ PERSONAL_OWNER_USER_ID: o.owner ?? 'user_a' }), jobDir: o.jobDir ?? null };
  const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
  const app = buildLocal({ config, pairing, runner: o.runner, fetch: o.fetch ?? bridge(server) });
  closers.push(app);
  return { app, pairing };
}
type Personal = ReturnType<typeof personal>;

async function pairAndLogin(p: Personal, loginId = 'user-a') {
  const pr = await p.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: p.pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
  expect(pr.statusCode).toBe(200);
  const h = { host: HOST, origin: ORIGIN, cookie: String(pr.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (pr.json() as { csrfToken: string }).csrfToken };
  const lr = await p.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId, password: PW }, headers: h });
  return { h, login: lr };
}
const generate = (p: Personal, h: Record<string, string>, key: string) =>
  p.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': key } });
async function settle(p: Personal, h: Record<string, string>, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const s = JobStatus.parse((await p.app.inject({ url: `/local/v1/jobs/${jobId}`, headers: h })).json());
    if (s.state === 'succeeded' || s.state === 'failed' || s.state === 'cancelled') return s;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}
async function sharedLogin(server: Server, loginId = 'user-a') {
  const r = await server.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
}
const batchCount = (db: ReturnType<typeof sharedServer>['db']) => (db.prepare('SELECT COUNT(*) AS n FROM plan_batches').get() as { n: number }).n;

describe('A04 end to end (fixture mode)', () => {
  it('pair -> login -> generate -> poll -> candidates are in the shared DB with known places only', async () => {
    const { app: server, db } = sharedServer();
    const runner = standIn();
    const seen: string[] = [];
    const p = personal(server, { runner, fetch: bridge(server, seen) });
    const { h, login } = await pairAndLogin(p);
    expect(login.statusCode).toBe(200);
    const g = await generate(p, h, 'key-e2e-0001');
    expect(g.statusCode).toBe(202);
    const job = await settle(p, h, g.json().jobId);
    expect(job).toMatchObject({ state: 'succeeded', stage: 'done' });
    expect(seen).toEqual(expect.arrayContaining(['POST /api/v1/planning-context', 'POST /api/v1/plan-batches']));
    expect(runner.calls).toBe(1);

    const res = await server.inject({ url: `/api/v1/plan-batches/${job.batchId}`, headers: await sharedLogin(server) });
    expect(res.statusCode).toBe(200);
    const batch = PlanBatch.parse(res.json());
    expect(batch.candidates.length).toBeGreaterThanOrEqual(1);
    expect(batch.candidates.length).toBeLessThanOrEqual(3);
    for (const c of batch.candidates) {
      expect(['valid', 'needs_review']).toContain(c.validationState); // not invalid: the must-visit place is in both
      for (const d of c.days) for (const it of d.items) {
        if (it.type === 'activity') expect(it.placeId === null || KNOWN.has(it.placeId)).toBe(true);
        else {
          expect(KNOWN.has(it.fromPlaceId) && KNOWN.has(it.toPlaceId)).toBe(true);
          expect(it.departure).toBeNull(); // fixture sample times are never shown as a timetable
        }
      }
    }
    expect(batch.places.every(pl => KNOWN.has(pl.placeId))).toBe(true);
    expect(batchCount(db)).toBe(1);
  });

  it('the same Idempotency-Key returns the same job and creates no second batch or run', async () => {
    const { app: server, db } = sharedServer();
    const runner = standIn();
    const p = personal(server, { runner });
    const { h } = await pairAndLogin(p);
    const a = (await generate(p, h, 'key-e2e-0002')).json().jobId as string;
    const first = await settle(p, h, a);
    const b = (await generate(p, h, 'key-e2e-0002')).json().jobId as string;
    expect(b).toBe(a);
    expect(await settle(p, h, b)).toMatchObject({ state: 'succeeded', batchId: first.batchId });
    expect(runner.calls).toBe(1);
    expect(batchCount(db)).toBe(1);
  });

  it('a save whose response is lost is found again by generationId (no duplicate batch)', async () => {
    const { app: server, db } = sharedServer();
    const hook = async (u: URL, init: RequestInit) => (u.pathname === '/api/v1/plan-batches' && init.method === 'POST' ? ('drop-response' as const) : null);
    const p = personal(server, { runner: standIn(), fetch: bridge(server, [], hook) });
    const { h } = await pairAndLogin(p);
    const job = await settle(p, h, (await generate(p, h, 'key-e2e-0003')).json().jobId);
    expect(job.state).toBe('succeeded');
    expect(job.batchId).not.toBeNull();
    expect(batchCount(db)).toBe(1);
  });

  it('restart recovery: a crash after the batch was committed is resolved by the same key without generating again', async () => {
    const { app: server, db } = sharedServer();
    const dir = mkdtempSync(join(tmpdir(), 'tkb-a04-'));
    dirs.push(dir);
    // First process: the save commits on the server but never answers; the process then "dies".
    const hang = async (u: URL, init: RequestInit) => (u.pathname === '/api/v1/plan-batches' && init.method === 'POST' ? ('hang' as const) : null);
    const hangBridge: FetchLike = async (url, init) => {
      const u = new URL(url);
      if (u.pathname === '/api/v1/plan-batches' && init.method === 'POST') {
        await server.inject({ method: 'POST', url: u.pathname, payload: init.body as string, headers: init.headers as Record<string, string> });
        return new Promise<Response>(() => {});
      }
      return bridge(server, [], hang)(url, init);
    };
    const r1 = standIn();
    const p1 = personal(server, { runner: r1, jobDir: dir, fetch: hangBridge });
    const s1 = await pairAndLogin(p1);
    const jobId = (await generate(p1, s1.h, 'key-e2e-0004')).json().jobId as string;
    for (let i = 0; i < 300 && batchCount(db) === 0; i++) await new Promise(r => setTimeout(r, 10));
    expect(batchCount(db)).toBe(1);
    await p1.app.close();
    closers.splice(closers.indexOf(p1.app), 1);

    const r2 = standIn();
    const p2 = personal(server, { runner: r2, jobDir: dir });
    await p2.app.ready();
    const s2 = await pairAndLogin(p2);
    const again = await generate(p2, s2.h, 'key-e2e-0004');
    expect(again.statusCode).toBe(202);
    const job = await settle(p2, s2.h, again.json().jobId);
    expect(jobId).toBeTruthy();
    expect(job.state).toBe('succeeded');
    expect(r2.calls).toBe(0); // found by generationId before any generation
    expect(batchCount(db)).toBe(1);
  });

  it('a non-owner cannot log in to the personal entry, and the shared entry has no /local routes', async () => {
    const { app: server } = sharedServer();
    const p = personal(server, { runner: standIn() });
    const { login } = await pairAndLogin(p, 'user-b');
    expect(login.statusCode).toBe(403);
    expect(ApiError.parse(login.json()).code).toBe('FORBIDDEN');
    for (const url of ['/local/v1/generations', '/local/v1/health', '/local/v1/jobs/x']) {
      expect((await server.inject({ url })).statusCode, url).toBe(404);
    }
  });

  it('a third party without a session cannot use K05 through the shared server', async () => {
    const { app: server } = sharedServer();
    const r = await server.inject({ method: 'POST', url: '/api/v1/planning-context', payload: { area: '金沢', transportMode: 'transit' } });
    expect(r.statusCode).toBe(401);
  });
});
