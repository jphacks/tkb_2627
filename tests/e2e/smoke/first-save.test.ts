// I01: login -> provisional itinerary -> server save -> re-display, against a real server process.
// Layer 1: apps/server as a child process (real port, temp file DB), restarted on the same DB.
// Layer 2: the U01 mock API and the real server answer with the same K09 shape.
// No external API and no real Claude. The web screens are still wired to the mock (see FINDINGS.md).
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, PlanBatch, PlanBatchCreated, Trip, TripList, TripWriteResult, type PlanCandidate } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { domesticTrip, kanazawaPlaces } from '@tkb/fixtures';
import { hashPassword } from '../../../apps/server/src/platform/auth/password.ts';
import { createMockApi } from '../../../apps/web/src/mocks/index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PW = 'correct horse battery';
const dir = mkdtempSync(join(tmpdir(), 'tkb-e2e-'));
const dbPath = join(dir, 'travel.sqlite');

interface Session { cookie: string; csrf: string }
let child: ChildProcess | null = null;
let base = '';

async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

async function startServer(): Promise<void> {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const c = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_PATH: dbPath,
      SHARED_PORT: String(port),
      SHARED_BIND: '127.0.0.1',
      PROVIDER_MODE: 'fixture',
      ALLOW_CLAUDE_EXECUTION: 'false',
      // Fixed secret so CSRF tokens would survive a restart; sessions come from the DB.
      SESSION_SECRET: 'e'.repeat(48),
      PUBLIC_ORIGIN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child = c;
  await new Promise<void>((res, rej) => {
    let out = '';
    const t = setTimeout(() => rej(new Error(`server did not start: ${out}`)), 30_000);
    const onData = (b: Buffer) => {
      out += b.toString();
      if (out.includes('listening on')) {
        clearTimeout(t);
        res();
      }
    };
    c.stdout!.on('data', onData);
    c.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    c.once('exit', code => {
      clearTimeout(t);
      rej(new Error(`server exited early (${code}): ${out}`));
    });
  });
}

async function stopServer(): Promise<void> {
  const c = child;
  child = null;
  if (!c || c.exitCode !== null) return;
  await new Promise<void>(res => {
    c.once('exit', () => res());
    c.kill('SIGTERM');
  });
}

async function login(loginId: string): Promise<Session> {
  const res = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password: PW }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { csrfToken: string };
  return { cookie: (res.headers.get('set-cookie') ?? '').split(';')[0]!, csrf: body.csrfToken };
}
const call = (s: Session | null, method: string, path: string, payload?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

function candidateFromFixture(): PlanCandidate {
  return {
    candidateId: 'cand_1',
    title: domesticTrip.title,
    days: structuredClone(domesticTrip.days),
    reasons: ['fixture'],
    warnings: [...domesticTrip.warnings],
    excludedPlaceIds: [],
    totalKnownCost: [{ amountMinor: 4520, currency: 'JPY' }],
    hasUnknownCost: true,
    validationState: domesticTrip.validationState,
  };
}

const saved: { tripId?: string; revision?: number; trip?: Trip } = {};

beforeAll(async () => {
  const db = openDatabase(dbPath);
  migrate(db);
  const hash = await hashPassword(PW);
  const now = '2026-10-24T03:00:00Z';
  for (const id of ['user_a', 'user_b']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: hash, displayName: id, createdAt: now });
  }
  db.close();
  await startServer();
}, 60_000);

afterAll(async () => {
  await stopServer();
  rmSync(dir, { recursive: true, force: true });
});

describe('I01 layer 1: real server, login -> save -> re-display', () => {
  it('health answers and unauthenticated trip access is 401', async () => {
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
    expect((await fetch(`${base}/api/v1/trips`)).status).toBe(401);
  });

  it('login, K07 save, K08 adopt, K09 list and detail show the provisional itinerary', async () => {
    const a = await login('user-a');
    const created = await call(a, 'POST', '/api/v1/plan-batches', {
      schemaVersion: 1,
      baseTripId: null,
      baseRevision: null,
      generationId: 'gen_i01',
      candidates: [candidateFromFixture()],
      places: kanazawaPlaces,
      constraints: domesticTrip.constraints,
    });
    expect(created.status).toBe(201);
    const batch = PlanBatchCreated.parse(await created.json());
    expect(batch.candidateIds).toEqual(['cand_1']);
    const got = PlanBatch.parse(await (await call(a, 'GET', `/api/v1/plan-batches/${batch.batchId}`)).json());
    expect(got.candidates).toHaveLength(1);

    const applied = await call(a, 'POST', '/api/v1/trips/apply-candidate', {
      batchId: batch.batchId, candidateId: 'cand_1', tripId: null, expectedRevision: null,
    });
    expect(applied.status).toBe(201);
    const w = TripWriteResult.parse(await applied.json());
    expect(w.revision).toBe(1);
    expect(w.trip.ownerId).toBe('user_a');
    saved.tripId = w.tripId;
    saved.revision = w.revision;

    const list = TripList.parse(await (await call(a, 'GET', '/api/v1/trips')).json());
    expect(list.items.map(i => i.tripId)).toContain(w.tripId);
    const detail = Trip.parse(await (await call(a, 'GET', `/api/v1/trips/${w.tripId}`)).json());
    expect(detail.title).toBe(domesticTrip.title);
    expect(detail.days.map(d => d.items.length)).toEqual(domesticTrip.days.map(d => d.items.length));
    expect(detail.validationState).toBe('needs_review');
    saved.trip = detail;
  });

  it('R25: after a server restart on the same DB, a fresh login reads the same itinerary', async () => {
    expect(saved.tripId).toBeTruthy();
    await stopServer();
    await startServer();
    const a2 = await login('user-a');
    const detail = Trip.parse(await (await call(a2, 'GET', `/api/v1/trips/${saved.tripId}`)).json());
    expect(detail).toEqual(saved.trip);
    const list = TripList.parse(await (await call(a2, 'GET', '/api/v1/trips')).json());
    expect(list.items.find(i => i.tripId === saved.tripId)?.revision).toBe(saved.revision);
  }, 60_000);

  it('R26: another user gets 404 for the trip, and it is absent from their list', async () => {
    const b = await login('user-b');
    const res = await call(b, 'GET', `/api/v1/trips/${saved.tripId}`);
    expect(res.status).toBe(404);
    const missing = await call(b, 'GET', '/api/v1/trips/trip_nope');
    expect(missing.status).toBe(404);
    expect({ ...ApiError.parse(await res.json()), requestId: '' }).toEqual({ ...ApiError.parse(await missing.json()), requestId: '' });
    const list = TripList.parse(await (await call(b, 'GET', '/api/v1/trips')).json());
    expect(list.items).toEqual([]);
  });

  const dist = resolve(ROOT, 'apps/web/dist/index.html');
  // dist is not built here (this test never runs a build); the skip reason is recorded in FINDINGS.md.
  it.skipIf(!existsSync(dist))('serves the web build at / with 200', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('I01 layer 2: mock screens and the real server share the K09 shape', () => {
  const SCREEN_FIELDS = ['tripId', 'title', 'revision', 'days', 'validationState', 'warnings'] as const;

  it('the mock getTrip/listTrips parse with the contracts schemas and carry the fields U01 uses', async () => {
    const mock = createMockApi();
    const list = await mock.listTrips();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    TripList.parse(list.data);
    const first = list.data.items[0]!;
    const got = await mock.getTrip(first.tripId);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const t = Trip.parse(got.data);
    for (const f of SCREEN_FIELDS) expect(t).toHaveProperty(f);
    expect(t.days.every(d => Array.isArray(d.items))).toBe(true);
  });

  it('the real server response has the same fields and the same parsed shape', async () => {
    const a = await login('user-a');
    const real = Trip.parse(await (await call(a, 'GET', `/api/v1/trips/${saved.tripId}`)).json());
    const mock = createMockApi();
    const m = await mock.getTrip(domesticTrip.tripId);
    expect(m.ok).toBe(true);
    if (!m.ok) return;
    for (const f of SCREEN_FIELDS) expect(real).toHaveProperty(f);
    expect(Object.keys(real).sort()).toEqual(Object.keys(m.data).sort());
    expect(Object.keys(real.days[0]!).sort()).toEqual(Object.keys(m.data.days[0]!).sort());
    expect(real.days[0]!.items.map(i => i.type)).toEqual(m.data.days[0]!.items.map(i => i.type));
    const rl = TripList.parse(await (await call(a, 'GET', '/api/v1/trips')).json());
    const ml = await mock.listTrips();
    if (!ml.ok) throw new Error('mock list failed');
    expect(Object.keys(rl.items[0]!).sort()).toEqual(Object.keys(ml.data.items[0]!).sort());
  });
});
