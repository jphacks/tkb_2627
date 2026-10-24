import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, PlanBatch, PlanBatchCreated, Trip, TripList, TripPatchResult, TripWriteResult } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';

const PW = 'correct horse battery';
const apps: ReturnType<typeof buildApp>[] = [];
const dirs: string[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

type App = ReturnType<typeof buildApp>;
interface Session { cookie: string; csrf: string }

function seed(db: ReturnType<typeof openDatabase>) {
  for (const id of ['user_a', 'user_b']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: new Date().toISOString() });
  }
}
const cfg = (databasePath: string) => ({ ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath });

function make() {
  const db = openDatabase(':memory:');
  migrate(db);
  seed(db);
  const app = buildApp({ config: cfg(':memory:'), db });
  apps.push(app);
  return { app, db };
}

async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const call = (app: App, s: Session, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });

const tz = 'Asia/Tokyo';
const place = (id: string): any => ({
  placeId: id, name: id, kind: 'spot', location: { lat: 35, lng: 139 }, timeZone: tz, openingHours: null, description: null, photo: null,
  dataStatus: 'fixture',
  provenance: { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null },
});
const activity = (id: string, hh: number, cost: number | null = null) => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: 'p1', areaName: null,
  start: { utc: `2026-11-01T0${hh}:00:00Z`, timeZone: tz }, end: { utc: `2026-11-01T0${hh + 1}:00:00Z`, timeZone: tz },
  fixed: false, status: 'planned', cost: cost === null ? null : { amountMinor: cost, currency: 'JPY' },
  costStatus: cost === null ? 'unknown' : 'fixture', privateNotes: null,
});
const candidate = (id: string, state = 'needs_review') => ({
  candidateId: id, title: `Plan ${id}`,
  days: [{ date: '2026-11-01', timeZone: tz, items: [activity('a1', 1, 500), activity('a2', 3)] }],
  reasons: [], warnings: ['w'], excludedPlaceIds: [], totalKnownCost: [{ amountMinor: 500, currency: 'JPY' }], hasUnknownCost: true, validationState: state,
});
const batchBody = (over: object = {}) => ({
  schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: `gen_${Math.random().toString(36).slice(2)}`,
  candidates: [candidate('c1'), candidate('c2', 'invalid')], places: [place('p1')],
  constraints: { area: 'Kanazawa', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: tz, transportMode: 'transit' }, ...over,
});

async function createBatch(app: App, s: Session, over: object = {}) {
  const res = await call(app, s, 'POST', '/api/v1/plan-batches', batchBody(over));
  expect(res.statusCode).toBe(201);
  return PlanBatchCreated.parse(res.json());
}
async function applyNew(app: App, s: Session) {
  const b = await createBatch(app, s);
  const res = await call(app, s, 'POST', '/api/v1/trips/apply-candidate', { batchId: b.batchId, candidateId: 'c1', tripId: null, expectedRevision: null });
  expect(res.statusCode).toBe(201);
  return TripWriteResult.parse(res.json());
}
const errOf = (res: { json: () => unknown }) => ApiError.parse(res.json());

describe('trips API', () => {
  it('auth: 401 unauthenticated, 403 without CSRF, no-store', async () => {
    const { app } = make();
    expect((await app.inject({ method: 'GET', url: '/api/v1/trips' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/plan-batches', payload: batchBody() })).statusCode).toBe(401);
    const a = await login(app, 'user-a');
    const res = await app.inject({ method: 'POST', url: '/api/v1/plan-batches', payload: batchBody(), headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(403);
    const t = await applyNew(app, a);
    const r = await app.inject({ method: 'PATCH', url: `/api/v1/trips/${t.tripId}`, payload: { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] }, headers: { cookie: a.cookie } });
    expect(r.statusCode).toBe(403);
    expect((await call(app, a, 'GET', '/api/v1/trips')).headers['cache-control']).toBe('no-store');
  });

  it('K07: stores batch, owner only, strict body, duplicates and bad json rejected', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const created = await createBatch(app, a);
    expect(created.candidateIds).toEqual(['c1', 'c2']);
    expect(created.validationState).toBe('invalid');
    const got = PlanBatch.parse((await call(app, a, 'GET', `/api/v1/plan-batches/${created.batchId}`)).json());
    expect(got.candidates).toHaveLength(2);
    expect((db.prepare('SELECT owner_id FROM plan_batches').get() as { owner_id: string }).owner_id).toBe('user_a');

    const other = await call(app, b, 'GET', `/api/v1/plan-batches/${created.batchId}`);
    const missing = await call(app, b, 'GET', '/api/v1/plan-batches/nope');
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    const o = errOf(other), m = errOf(missing);
    expect({ ...o, requestId: '' }).toEqual({ ...m, requestId: '' });

    const withOwner = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ ownerId: 'user_b' }));
    expect(withOwner.statusCode).toBe(422);
    expect(errOf(withOwner).code).toBe('VALIDATION_FAILED');
    const dup = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ candidates: [candidate('c1'), candidate('c1')] }));
    expect(dup.statusCode).toBe(422);
    const bad = await app.inject({ method: 'POST', url: '/api/v1/plan-batches', payload: '{"a":', headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(422);
    errOf(bad);
    const restricted = place('p1');
    restricted.provenance.mayStore = false;
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ places: [restricted] }))).statusCode).toBe(422);
  });

  it('K07: a batch referencing places it does not carry is refused (A04); client "valid" is downgraded; generationId is idempotent', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const dangling = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ candidates: [candidate('c1', 'valid')], places: [] }));
    expect(dangling.statusCode).toBe(422);
    expect(errOf(dangling).code).toBe('VALIDATION_FAILED');
    const body = batchBody({ candidates: [candidate('c1', 'valid')] });
    const r1 = await call(app, a, 'POST', '/api/v1/plan-batches', body);
    expect(PlanBatchCreated.parse(r1.json()).validationState).toBe('needs_review');
    const r2 = await call(app, a, 'POST', '/api/v1/plan-batches', body);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().batchId).toBe(r1.json().batchId);
    const r3 = await call(app, a, 'POST', '/api/v1/plan-batches', { ...body, candidates: [candidate('c9')] });
    expect(r3.statusCode).toBe(409);
    expect(errOf(r3).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('K07: places and legs labelled google_* must carry ids only (the label is not trusted)', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const google = (over: object = {}) => {
      const p = place('p1');
      p.provenance = { ...p.provenance, source: 'google_places', mayStore: true, maySendToModel: false, mayExport: false };
      p.location = null;
      return { ...p, ...over };
    };
    const ok = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ places: [google()] }));
    expect(ok.statusCode).toBe(201);
    for (const over of [{ location: { lat: 1, lng: 2 } }, { openingHours: '9-17' }, { description: 'x' }, { photo: { url: 'https://e.test/a.jpg', attribution: 'a', license: null } }]) {
      const r = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ places: [google(over)] }));
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
      expect(errOf(r).code).toBe('RESTRICTED_ASSET');
    }
    const leg = (over: object = {}) => ({
      type: 'leg', legId: 'l1', mode: 'transit', fromPlaceId: 'p1', toPlaceId: 'p1', departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null,
      dataStatus: 'unknown', provenance: { source: 'google_routes', fetchedAt: null, attribution: null, maySendToModel: false, mayStore: true, mayExport: false, retainUntil: null }, ...over,
    });
    const withLeg = (l: object) => {
      const c = candidate('c1');
      c.days[0]!.items.splice(1, 0, l as never);
      return batchBody({ candidates: [c], places: [place('p1')] });
    };
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', withLeg(leg()))).statusCode).toBe(201);
    for (const over of [{ durationSeconds: 60 }, { fare: { amountMinor: 1, currency: 'JPY' } }, { lineName: 'L' }, { platform: '1' }, { transfers: 0 }]) {
      const r = await call(app, a, 'POST', '/api/v1/plan-batches', withLeg(leg(over)));
      expect(r.statusCode, JSON.stringify(over)).toBe(422);
      expect(errOf(r).code).toBe('RESTRICTED_ASSET');
    }
  });

  it('K07: baseTripId must be mine and baseRevision current', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const t = await applyNew(app, a);
    expect((await call(app, b, 'POST', '/api/v1/plan-batches', batchBody({ baseTripId: t.tripId, baseRevision: 1 }))).statusCode).toBe(404);
    const stale = await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ baseTripId: t.tripId, baseRevision: 5 }));
    expect(stale.statusCode).toBe(409);
    expect(errOf(stale).details).toEqual({ expectedRevision: 5, currentRevision: 1 });
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ baseTripId: t.tripId, baseRevision: 1 }))).statusCode).toBe(201);
  });

  it('K08: apply new (201), invalid candidate 422, other owner 404, stale 409, update 200', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const batch = await createBatch(app, a);
    const apply = (s: Session, p: object) => call(app, s, 'POST', '/api/v1/trips/apply-candidate', p);
    const base: { batchId: string; candidateId: string; tripId: string | null; expectedRevision: number | null } = { batchId: batch.batchId, candidateId: 'c1', tripId: null, expectedRevision: null };

    expect((await apply(a, { ...base, candidateId: 'c2' })).statusCode).toBe(422);
    const stolen = await apply(b, base);
    const unknown = await apply(b, { ...base, batchId: 'nope' });
    expect(stolen.statusCode).toBe(404);
    expect({ ...errOf(stolen), requestId: '' }).toEqual({ ...errOf(unknown), requestId: '' });
    expect((await apply(a, { ...base, ownerId: 'user_b' })).statusCode).toBe(422);

    const first = await apply(a, base);
    expect(first.statusCode).toBe(201);
    const t = TripWriteResult.parse(first.json());
    expect(t.revision).toBe(1);
    expect(t.trip.ownerId).toBe('user_a');
    expect(db.prepare('SELECT COUNT(*) AS n FROM posts').get()).toEqual({ n: 0 });

    expect((await apply(b, { ...base, tripId: t.tripId, expectedRevision: 1 })).statusCode).toBe(404);
    expect((await apply(a, { ...base, tripId: t.tripId, expectedRevision: null })).statusCode).toBe(422);
    // a batch without baseTripId cannot be applied to an existing trip
    expect((await apply(a, { ...base, tripId: t.tripId, expectedRevision: 1 })).statusCode).toBe(422);
    const based = await createBatch(app, a, { baseTripId: t.tripId, baseRevision: 1 });
    base.batchId = based.batchId;
    const stale = await apply(a, { ...base, tripId: t.tripId, expectedRevision: 7 });
    expect(stale.statusCode).toBe(409);
    expect(errOf(stale)).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 7, currentRevision: 1 } });
    const upd = await apply(a, { ...base, tripId: t.tripId, expectedRevision: 1 });
    expect(upd.statusCode).toBe(200);
    expect(TripWriteResult.parse(upd.json()).revision).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trip_versions WHERE trip_id = ?').get(t.tripId)).toEqual({ n: 2 });
  });

  it('K09: list newest first with cursor; detail 404 for other owner, missing and deleted', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const t1 = await applyNew(app, a);
    await new Promise((r) => setTimeout(r, 1100));
    const t2 = await applyNew(app, a);
    const list = TripList.parse((await call(app, a, 'GET', '/api/v1/trips?limit=1')).json());
    expect(list.items.map((i) => i.tripId)).toEqual([t2.tripId]);
    expect(list.nextCursor).not.toBeNull();
    const page2 = TripList.parse((await call(app, a, 'GET', `/api/v1/trips?limit=1&cursor=${list.nextCursor}`)).json());
    expect(page2.items.map((i) => i.tripId)).toEqual([t1.tripId]);
    expect(page2.nextCursor).toBeNull();
    expect(TripList.parse((await call(app, b, 'GET', '/api/v1/trips')).json()).items).toEqual([]);
    expect((await call(app, a, 'GET', '/api/v1/trips?limit=0')).statusCode).toBe(422);
    expect((await call(app, a, 'GET', '/api/v1/trips?cursor=%%')).statusCode).toBe(422);

    expect(Trip.parse((await call(app, a, 'GET', `/api/v1/trips/${t1.tripId}`)).json()).tripId).toBe(t1.tripId);
    const other = await call(app, b, 'GET', `/api/v1/trips/${t1.tripId}`);
    expect(other.statusCode).toBe(404);
    db.prepare("UPDATE trips SET deleted_at = '2026-11-02T00:00:00Z' WHERE id = ?").run(t1.tripId);
    expect((await call(app, a, 'GET', `/api/v1/trips/${t1.tripId}`)).statusCode).toBe(404);
    expect((await call(app, a, 'PATCH', `/api/v1/trips/${t1.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] })).statusCode).toBe(404);
    expect(TripList.parse((await call(app, a, 'GET', '/api/v1/trips')).json()).items.map((i) => i.tripId)).toEqual([t2.tripId]);
  });

  it('K10: two browsers with the same revision -> one 200, one 409', async () => {
    const { app, db } = make();
    const a1 = await login(app, 'user-a');
    const a2 = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const t = await applyNew(app, a1);
    const patch = (s: Session, title: string) =>
      call(app, s, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title }] });
    const [r1, r2] = await Promise.all([patch(a1, 'from browser 1'), patch(a2, 'from browser 2')]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 409]);
    const loser = r1.statusCode === 409 ? r1 : r2;
    expect(errOf(loser)).toMatchObject({ code: 'REVISION_CONFLICT', details: { currentRevision: 2 } });
    expect(db.prepare('SELECT COUNT(*) AS n FROM trip_versions WHERE trip_id = ?').get(t.tripId)).toEqual({ n: 2 });
    expect((await call(app, b, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 2, operations: [{ op: 'set_title', title: 'x' }] })).statusCode).toBe(404);
  });

  it('K10: operations, diff, needs_revalidation, strict body, unknown id', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const t = await applyNew(app, a);
    const url = `/api/v1/trips/${t.tripId}`;
    const rm = await call(app, a, 'PATCH', url, { expectedRevision: 1, operations: [{ op: 'remove', itemId: 'a1' }] });
    expect(rm.statusCode).toBe(200);
    const res = TripPatchResult.parse(rm.json());
    expect(res.revision).toBe(2);
    expect(res.trip.validationState).toBe('needs_revalidation');
    expect(res.diff.knownCostDelta).toEqual([{ amountMinor: -500, currency: 'JPY' }]);
    expect(res.diff.unknownCostItems).toEqual(['a2']);
    const unk = await call(app, a, 'PATCH', url, { expectedRevision: 2, operations: [{ op: 'remove', itemId: 'zzz' }] });
    expect(unk.statusCode).toBe(422);
    expect(errOf(unk).code).toBe('CONSTRAINT_UNSATISFIED');
    expect((await call(app, a, 'GET', url)).json().revision).toBe(2);
    expect((await call(app, a, 'PATCH', url, { expectedRevision: 2, ownerId: 'user_b', operations: [{ op: 'set_title', title: 'x' }] })).statusCode).toBe(422);
    expect((await call(app, a, 'PATCH', url, { expectedRevision: 2, operations: [{ op: 'drop_table' }] })).statusCode).toBe(422);
    const stale = await call(app, a, 'PATCH', url, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'x' }] });
    expect(stale.statusCode).toBe(409);
  });

  it('persists across an app restart on a file database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tkb-trips-'));
    dirs.push(dir);
    const path = join(dir, 'app.db');
    const seedDb = openDatabase(path);
    migrate(seedDb);
    seed(seedDb);
    seedDb.close();
    const app1 = buildApp({ config: cfg(path) });
    const a = await login(app1, 'user-a');
    const t = await applyNew(app1, a);
    await call(app1, a, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'persisted' }] });
    await app1.close();
    const app2 = buildApp({ config: cfg(path) });
    apps.push(app2);
    const a2 = await login(app2, 'user-a');
    const got = Trip.parse((await call(app2, a2, 'GET', `/api/v1/trips/${t.tripId}`)).json());
    expect(got).toMatchObject({ title: 'persisted', revision: 2 });
  });

  it('B1: no constraints -> cannot create a new trip; base trip constraints are used for updates', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const { constraints: _c, ...noCons } = batchBody();
    const b = await call(app, a, 'POST', '/api/v1/plan-batches', noCons);
    expect(b.statusCode).toBe(201);
    const r = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', { batchId: b.json().batchId, candidateId: 'c1', tripId: null, expectedRevision: null });
    expect(r.statusCode).toBe(422);
    expect(errOf(r).code).toBe('CONSTRAINT_UNSATISFIED');
    const t = await applyNew(app, a);
    expect(t.trip.constraints.area).toBe('Kanazawa');
    const b2 = await call(app, a, 'POST', '/api/v1/plan-batches', { ...noCons, generationId: 'gen_other', baseTripId: t.tripId, baseRevision: 1 });
    const up = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', { batchId: b2.json().batchId, candidateId: 'c1', tripId: t.tripId, expectedRevision: 1 });
    expect(up.statusCode).toBe(200);
    expect(TripWriteResult.parse(up.json()).trip.constraints.area).toBe('Kanazawa');
  });

  it('B2: expired or non-storable provenance is rejected at save, apply, read and edit', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const past = place('p1');
    past.provenance.retainUntil = '2020-01-01T00:00:00Z';
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ places: [past] }))).statusCode).toBe(422);
    const prov = { source: 'x', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: false, mayExport: true, retainUntil: null };
    const leg = (id: string, p: object | null) => ({ type: 'leg', legId: id, mode: 'transit', fromPlaceId: 'p1', toPlaceId: 'p1', departure: null, arrival: null, durationSeconds: null, lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'fixture', provenance: p });
    const c = candidate('c1');
    c.days[0]!.items.push(leg('l1', prov) as never);
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', batchBody({ candidates: [c] }))).statusCode).toBe(422);

    const batch = await createBatch(app, a);
    const stored = db.prepare('SELECT places_json FROM plan_batches').get() as { places_json: string };
    const w = JSON.parse(stored.places_json);
    w.places[0].provenance.retainUntil = '2020-01-01T00:00:00Z';
    db.prepare('UPDATE plan_batches SET places_json = ?').run(JSON.stringify(w));
    const g = await call(app, a, 'GET', `/api/v1/plan-batches/${batch.batchId}`);
    expect(g.statusCode).toBe(410);
    expect(errOf(g).code).toBe('EXPIRED');
    const ap = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', { batchId: batch.batchId, candidateId: 'c1', tripId: null, expectedRevision: null });
    expect(ap.statusCode).toBe(422);
    expect(errOf(ap).code).toBe('RESTRICTED_ASSET');

    const t = await applyNew(app, a);
    const add = await call(app, a, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 1, operations: [{ op: 'add', dayIndex: 0, position: 0, item: leg('l9', prov) }] });
    expect(add.statusCode).toBe(422);
    expect(errOf(add).code).toBe('RESTRICTED_ASSET');
  });

  it('B3: applying to a trip whose revision moved past batch.baseRevision is 409', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const t = await applyNew(app, a);
    const b = await createBatch(app, a, { baseTripId: t.tripId, baseRevision: 1 });
    await call(app, a, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'moved' }] });
    const r = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', { batchId: b.batchId, candidateId: 'c1', tripId: t.tripId, expectedRevision: 2 });
    expect(r.statusCode).toBe(409);
    expect(errOf(r).details).toEqual({ expectedRevision: 1, currentRevision: 2 });
  });

  it('B4: applying the same candidate into a new trip twice is idempotent; deleted trip -> 409 ALREADY_COMMITTED', async () => {
    const { app, db } = make();
    const a = await login(app, 'user-a');
    const b = await createBatch(app, a);
    const req = { batchId: b.batchId, candidateId: 'c1', tripId: null, expectedRevision: null };
    const r1 = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', req);
    const r2 = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', req);
    expect(r1.statusCode).toBe(201);
    expect(r2.statusCode).toBe(200);
    expect(r2.json().tripId).toBe(r1.json().tripId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM trips').get()).toEqual({ n: 1 });
    db.prepare("UPDATE trips SET deleted_at = '2026-11-02T00:00:00Z'").run();
    const r3 = await call(app, a, 'POST', '/api/v1/trips/apply-candidate', req);
    expect(r3.statusCode).toBe(409);
    expect(errOf(r3).code).toBe('ALREADY_COMMITTED');
  });

  it('O1/O2/O4: replay precedes checks; client valid is capped; unknown placeId rejected on edit', async () => {
    const { app } = make();
    const a = await login(app, 'user-a');
    const body = batchBody({ candidates: [candidate('c1', 'valid')] });
    const r1 = await call(app, a, 'POST', '/api/v1/plan-batches', body);
    expect(r1.json().validationState).toBe('needs_review');
    const t = await applyNew(app, a);
    const withBase = { ...body, generationId: 'gen_base', baseTripId: t.tripId, baseRevision: 1 };
    const rb = await call(app, a, 'POST', '/api/v1/plan-batches', withBase);
    expect(rb.statusCode).toBe(201);
    await call(app, a, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'n' }] });
    expect((await call(app, a, 'POST', '/api/v1/plan-batches', withBase)).statusCode).toBe(200);
    const item = { ...activity('a9', 5), placeId: 'ghost' };
    const bad = await call(app, a, 'PATCH', `/api/v1/trips/${t.tripId}`, { expectedRevision: 2, operations: [{ op: 'add', dayIndex: 0, position: 0, item }] });
    expect(bad.statusCode).toBe(422);
    expect(errOf(bad).code).toBe('CONSTRAINT_UNSATISFIED');
  });
});
