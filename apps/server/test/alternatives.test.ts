// A05 POST /api/v1/trips/:id/alternatives: preview only, fixture and fake-fetch sources (no real provider call).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ApiError, Trip, type PlaceInfo, type TravelLeg, type TripOperation } from '@tkb/contracts';
import { createUser, getTripForOwner, insertTrip, migrate, openDatabase } from '@tkb/db';
import { FixtureRouteProvider, type RouteProvider } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { AlternativesResult } from '../src/trips/alternatives/index.ts';
import { registerTrips } from '../src/trips/index.ts';
import { registerPlanningContext } from '../src/trips/generation/index.ts';
import { createUserRouteBudget, liveRouteCallsPerUserFromEnv, type UserRouteBudget } from '../src/trips/generation/live-route-budget.ts';
import { applyOperations, computeDiff } from '../src/trips/operations.ts';
import { createContextSources, type ContextSources } from '../src/trips/generation/sources.ts';

const PW = 'correct horse battery';
const tz = 'Asia/Tokyo';
const closers: { close(): Promise<unknown> }[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});

const fixProv = { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null };
const place = (n: number, kind: PlaceInfo['kind'] = 'spot'): PlaceInfo => ({
  placeId: `P${n}`, name: `Place ${n}`, kind, location: { lat: 35 + n * 0.05, lng: 139 }, timeZone: tz,
  openingHours: null, description: null, photo: null, dataStatus: 'fixture', provenance: fixProv,
});
/** Minutes after 09:00 JST on 2026-11-01. */
const at = (min: number) => ({ utc: new Date(Date.UTC(2026, 10, 1, 0, 0) + min * 60_000).toISOString().replace(/\.000Z$/, 'Z'), timeZone: tz });
const act = (id: string, p: number | null, from: number | null, to: number | null, extra: object = {}): any => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: p === null ? null : `P${p}`, areaName: null,
  start: from === null ? null : at(from), end: to === null ? null : at(to), fixed: false, status: 'planned',
  cost: null, costStatus: 'unknown', privateNotes: null, ...extra,
});
const legOf = (a: number, b: number, sec: number | null, fare: number | null = null, id = `L${a}_${b}`): TravelLeg => ({
  type: 'leg', legId: id, mode: 'transit', fromPlaceId: `P${a}`, toPlaceId: `P${b}`, departure: null, arrival: null, durationSeconds: sec,
  lineName: null, platform: null, transfers: null, fare: fare === null ? null : { amountMinor: fare, currency: 'JPY' },
  dataStatus: sec === null ? 'unknown' : 'fixture', provenance: sec === null ? null : fixProv,
});
/** Provider legs between P1..P6: |i-j| x 10 minutes. Fare is unknown for anything touching P6. P7 has no legs at all. */
const MATRIX: TravelLeg[] = [];
for (let i = 1; i <= 6; i++) for (let j = 1; j <= 6; j++) if (i !== j) MATRIX.push(legOf(i, j, Math.abs(i - j) * 600, i === 6 || j === 6 ? null : Math.abs(i - j) * 100, `M${i}_${j}`));

const mkTrip = (items: unknown[], extra: object = {}) =>
  Trip.parse({
    schemaVersion: 1, tripId: 't_a05', ownerId: 'user_a', title: 'T', revision: 1,
    constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: tz, transportMode: 'transit' },
    days: [{ date: '2026-11-01', timeZone: tz, items }, { date: '2026-11-02', timeZone: tz, items: [] }],
    places: [1, 2, 3, 4, 5, 6, 7].map(n => place(n)), validationState: 'valid', warnings: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
  });
/** a1(P1) -10m- a2(P2) -10m- a3(P3), 50 minute stays, with the stored legs. */
const baseItems = () => [
  act('a1', 1, 0, 50), { ...legOf(1, 2, 600, null, 'l12'), departure: at(50), arrival: at(60) },
  act('a2', 2, 60, 110), { ...legOf(2, 3, 600, null, 'l23'), departure: at(110), arrival: at(120) },
  act('a3', 3, 120, 170),
];

function seedUsers(db: ReturnType<typeof openDatabase>) {
  for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
}

/** Mini app with a fake session (no CSRF layer) and injectable sources. */
function mini(trip: Trip, sources: ContextSources = { ...createContextSources({ providerMode: 'fixture' }), routes: new FixtureRouteProvider(MATRIX) }, _mode: 'fixture' | 'mixed' = 'fixture', routeBudget: UserRouteBudget = createUserRouteBudget({ perDay: 20 })) {
  const db = openDatabase(':memory:');
  migrate(db);
  seedUsers(db);
  insertTrip(db, 'user_a', trip, '2026-10-01T00:00:00Z');
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'user_a', displayName: 'A' }));
  registerTrips(app, db, { providerMode: 'fixture' } as never, { alternatives: { sources, routeBudget } });
  closers.push(app);
  const patch = (revision: number, operations: unknown, id = trip.tripId) => app.inject({ method: 'PATCH', url: `/api/v1/trips/${id}`, payload: { expectedRevision: revision, operations } as object });
  const post = async (payload: unknown, id = trip.tripId) => app.inject({ method: 'POST', url: `/api/v1/trips/${id}/alternatives`, payload: payload as object });
  const preview = async (operations: TripOperation[], extra: object = {}) => {
    const r = await post({ expectedRevision: 1, operations, ...extra });
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as AlternativesResult;
  };
  return { app, db, post, preview, patch };
}
const acts = (t: Trip, d = 0) => t.days[d]!.items.filter(i => i.type === 'activity') as any[];
const startMin = (a: any) => (Date.parse(a.start.utc) - Date.UTC(2026, 10, 1)) / 60000;

describe('A05 over the real shared app (auth, ownership, conflicts, no writes)', () => {
  function real() {
    const db = openDatabase(':memory:');
    migrate(db);
    seedUsers(db);
    insertTrip(db, 'user_a', mkTrip(baseItems()), '2026-10-01T00:00:00Z');
    const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
    closers.push(app);
    const login = async (loginId: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
    };
    const send = (method: 'POST' | 'PATCH' | 'GET', url: string, headers: Record<string, string>, payload?: unknown) => app.inject({ method, url, payload: payload as object, headers });
    return { app, db, login, send };
  }
  const URL = '/api/v1/trips/t_a05/alternatives';
  const ops: TripOperation[] = [{ op: 'remove', itemId: 'a2' }];
  const counts = (db: ReturnType<typeof openDatabase>) =>
    ['trips', 'trip_versions', 'plan_batches'].map(t => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);

  it('401 without a session, 403 without CSRF, identical 404 for other owner / missing / deleted, no-store', async () => {
    const { app, db, login, send } = real();
    expect((await send('POST', URL, {}, { expectedRevision: 1, operations: ops })).statusCode).toBe(401);
    const a = await login('user-a');
    const b = await login('user-b');
    expect((await send('POST', URL, { cookie: a.cookie }, { expectedRevision: 1, operations: ops })).statusCode).toBe(403);
    const ok = await send('POST', URL, a, { expectedRevision: 1, operations: ops });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    const other = await send('POST', URL, b, { expectedRevision: 1, operations: ops });
    const missing = await send('POST', '/api/v1/trips/nope/alternatives', a, { expectedRevision: 1, operations: ops });
    db.prepare("UPDATE trips SET deleted_at = '2026-10-02T00:00:00Z' WHERE id = 't_a05'").run();
    const deleted = await send('POST', URL, a, { expectedRevision: 1, operations: ops });
    for (const r of [other, missing, deleted]) {
      expect(r.statusCode).toBe(404);
      expect({ ...r.json(), requestId: 0 }).toEqual({ ...other.json(), requestId: 0 });
    }
    void app;
  });

  it('rejects malformed bodies (422 VALIDATION_FAILED): unknown keys, bad maxAlternatives, empty or >50 operations', async () => {
    const { login, send } = real();
    const a = await login('user-a');
    const many = Array.from({ length: 51 }, () => ({ op: 'set_title', title: 'x' }));
    for (const bad of [{}, { expectedRevision: 1, operations: [] }, { expectedRevision: 1, operations: many }, { expectedRevision: 1, operations: ops, extra: 1 }, { expectedRevision: 1, operations: ops, maxAlternatives: 4 }, { expectedRevision: 1, operations: ops, maxAlternatives: 0 }, { expectedRevision: 1, operations: [{ op: 'explode' }] }]) {
      const r = await send('POST', URL, a, bad);
      expect(r.statusCode, JSON.stringify(bad).slice(0, 80)).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('stale expectedRevision -> 409 with details; an operation that cannot apply -> 422 with operationIndex', async () => {
    const { login, send } = real();
    const a = await login('user-a');
    const stale = await send('POST', URL, a, { expectedRevision: 7, operations: ops });
    expect(stale.statusCode).toBe(409);
    expect(ApiError.parse(stale.json())).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 7, currentRevision: 1 } });
    const bad = await send('POST', URL, a, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'ok' }, { op: 'remove', itemId: 'ghost' }] });
    expect(bad.statusCode).toBe(422);
    expect(ApiError.parse(bad.json())).toMatchObject({ code: 'CONSTRAINT_UNSATISFIED', details: { operationIndex: 1 } });
  });

  it('writes nothing: rows, revision and the stored trip are unchanged after previews', async () => {
    const { db, login, send } = real();
    const a = await login('user-a');
    const before = [counts(db), JSON.stringify(getTripForOwner(db, 't_a05', 'user_a'))];
    for (const o of [ops, [{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 4 }], [{ op: 'set_title', title: 'New' }]]) {
      expect((await send('POST', URL, a, { expectedRevision: 1, operations: o })).statusCode).toBe(200);
    }
    expect([counts(db), JSON.stringify(getTripForOwner(db, 't_a05', 'user_a'))]).toEqual(before);
    expect(getTripForOwner(db, 't_a05', 'user_a')!.revision).toBe(1);
  });

  it('applying a preview goes through K10: the candidate operations reproduce it; after another edit the old revision is refused and nothing changes', async () => {
    const { db, login, send } = real();
    const a = await login('user-a');
    const r = (await send('POST', URL, a, { expectedRevision: 1, operations: [{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 4 }] })).json() as AlternativesResult;
    const chosen = r.candidates[0]!;
    expect(chosen.operations).not.toBeNull();
    // someone else edits first
    const bump = await send('PATCH', '/api/v1/trips/t_a05', a, { expectedRevision: 1, operations: [{ op: 'set_title', title: 'Other edit' }] });
    expect(bump.statusCode).toBe(200);
    const snapshot = [counts(db), JSON.stringify(getTripForOwner(db, 't_a05', 'user_a'))];
    const stale = await send('PATCH', '/api/v1/trips/t_a05', a, { expectedRevision: r.baseRevision, operations: chosen.operations });
    expect(stale.statusCode).toBe(409);
    expect(ApiError.parse(stale.json())).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: 2 } });
    expect([counts(db), JSON.stringify(getTripForOwner(db, 't_a05', 'user_a'))]).toEqual(snapshot);
    // on a fresh preview the same route applies it, and the stored days equal the previewed days
    const r2 = (await send('POST', URL, a, { expectedRevision: 2, operations: [{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 4 }] })).json() as AlternativesResult;
    const ok = await send('PATCH', '/api/v1/trips/t_a05', a, { expectedRevision: r2.baseRevision, operations: r2.candidates[0]!.operations });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().trip.days).toEqual(r2.candidates[0]!.trip.days);
  });
});

describe('A05 affected segments and re-timing', () => {
  it('same-area replacement changes travel time, later start times and the diff', async () => {
    // a2 moves from P2 to P4 (same area, longer ride): a1->a2 becomes 30 min and a2->a3 20 min.
    const { preview } = mini(mkTrip(baseItems()));
    const r = await preview([{ op: 'update', itemId: 'a2', item: act('a2', 4, 60, 110) }]);
    const c = r.candidates[0]!;
    expect(c.kind).toBe('requested');
    expect(acts(c.trip).map(a => [a.activityId, startMin(a)])).toEqual([['a1', 0], ['a2', 80], ['a3', 140]]);
    expect(acts(c.trip)[0].start).toEqual(at(0)); // the unchanged leading activity is untouched
    expect(c.trip.days[0]!.items.filter(i => i.type === 'leg').map((l: any) => [l.fromPlaceId, l.toPlaceId, l.durationSeconds])).toEqual([['P1', 'P4', 1800], ['P4', 'P3', 600]]);
    // before: 0..170, after: 0..190 -> +20 min
    expect(c.diff.durationDeltaSeconds).toBe(1200);
    expect(c.affectedSegments).toEqual([
      { dayIndex: 0, fromItemId: 'a1', toItemId: 'a2', travel: 'known' },
      { dayIndex: 0, fromItemId: 'a2', toItemId: 'a3', travel: 'known' },
    ]);
    expect(c.trip.validationState).toBe('needs_revalidation');
    expect(c.trip.revision).toBe(1);
  });

  it('affected segments: move, remove, add and update (and none for a title-only edit)', async () => {
    const { preview } = mini(mkTrip(baseItems()));
    const segs = async (ops: TripOperation[]) => (await preview(ops)).candidates[0]!.affectedSegments.map(s => `${s.fromItemId}>${s.toItemId}`);
    expect(await segs([{ op: 'remove', itemId: 'a2' }])).toEqual(['a1>a3']);
    expect(await segs([{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 4 }])).toEqual(['a3>a1']);
    expect(await segs([{ op: 'add', dayIndex: 0, position: 1, item: act('n1', 5, 55, 100) }])).toEqual(['a1>n1', 'n1>a2']);
    expect(await segs([{ op: 'update', itemId: 'a3', item: act('a3', 5, 120, 170) }])).toEqual(['a2>a3']);
    const t = (await preview([{ op: 'set_title', title: 'Renamed' }])).candidates[0]!;
    expect(t.affectedSegments).toEqual([]);
    expect(t.diff).toMatchObject({ durationDeltaSeconds: 0, knownCostDelta: [] }); // costs unknown on both sides stay listed, not 0
    expect(t.trip.title).toBe('Renamed');
  });

  it('a fixed activity stays where it is and an unchanged prefix keeps its times', async () => {
    const items = [act('a1', 1, 0, 50), act('f', 5, 200, 260, { fixed: true }), act('a3', 3, 300, 350)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'add', dayIndex: 0, position: 1, item: act('n', 2, 55, 100) }])).candidates[0]!;
    const f = acts(c.trip).find(a => a.activityId === 'f');
    expect(f.start).toEqual(at(200));
    expect(acts(c.trip).find(a => a.activityId === 'n').start).toEqual(at(60)); // a1 ends 50, 10 min ride
  });

  it('unknown travel stays unknown: the stop and what follows are untimed with a warning, no leg or duration is invented', async () => {
    const { preview } = mini(mkTrip(baseItems()));
    const c = (await preview([{ op: 'update', itemId: 'a2', item: act('a2', 7, 60, 110) }])).candidates[0]!;
    const a2 = acts(c.trip).find(a => a.activityId === 'a2');
    const a3 = acts(c.trip).find(a => a.activityId === 'a3');
    expect(a2).toMatchObject({ start: null, end: null });
    expect(a3).toMatchObject({ start: null, end: null });
    expect(c.trip.days[0]!.items.some(i => i.type === 'leg' && (i.fromPlaceId === 'P7' || i.toPlaceId === 'P7'))).toBe(false);
    expect(c.unknown).toContain('legs');
    expect(c.warnings.some(w => w.includes('a2') && w.includes('移動時間が不明'))).toBe(true);
    expect(c.affectedSegments[0]).toMatchObject({ fromItemId: 'a1', toItemId: 'a2', travel: 'unknown' });
    expect(c.diff.durationDeltaSeconds).toBeNull(); // unknown, not 0
  });

  it('costs: known delta per currency, unknown items from both sides, never counted as 0', async () => {
    const items = [
      act('a1', 1, 0, 50, { cost: { amountMinor: 1000, currency: 'JPY' }, costStatus: 'verified' }),
      act('a2', 2, 60, 110, { cost: { amountMinor: 20, currency: 'EUR' }, costStatus: 'verified' }),
      act('a3', 3, 120, 170),
    ];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'remove', itemId: 'a2' }, { op: 'add', dayIndex: 0, position: 2, item: act('a4', 6, 180, 200, { cost: { amountMinor: 300, currency: 'JPY' }, costStatus: 'verified' }) }])).candidates[0]!;
    expect(c.diff.knownCostDelta).toEqual(expect.arrayContaining([{ amountMinor: -20, currency: 'EUR' }]));
    expect(c.diff.knownCostDelta.find(m => m.currency === 'JPY')).toBeDefined();
    expect(c.diff.unknownCostItems).toContain('a3');
    // legs that now appear with an unknown fare are unknown, not free
    const legIds = c.trip.days[0]!.items.filter((i): i is TravelLeg => i.type === 'leg' && i.fare === null).map(l => l.legId);
    expect(legIds.length).toBeGreaterThan(0);
    expect(c.unknown).toContain('fare');
    for (const id of legIds) expect(c.diff.unknownCostItems).toContain(id);
  });

  it('is deterministic: same request, same bytes', async () => {
    const { post } = mini(mkTrip(baseItems()));
    const body = { expectedRevision: 1, operations: [{ op: 'move', itemId: 'a1', toDayIndex: 0, toPosition: 4 }] };
    const a = await post(body);
    const b = await post(body);
    expect(a.payload).toBe(b.payload);
  });
});

describe('A05 variants (deterministic, no AI)', () => {
  it('offers a reordered day with less known travel, and applying its operations reproduces it', async () => {
    // a1(P1) a2(P3) a3(P2): the stored order rides 20 + 10 min, P1 -> P2 -> P3 needs 10 + 10.
    const items = [act('a1', 1, 0, 50), act('a2', 3, 70, 120), act('a3', 2, 130, 180)];
    const trip = mkTrip(items);
    const { preview } = mini(trip);
    const r = await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 40) }]);
    const reorder = r.candidates.find(c => c.kind === 'reorder')!;
    expect(reorder).toBeDefined();
    expect(acts(reorder.trip).map(a => a.activityId)).toEqual(['a1', 'a3', 'a2']);
    const req = r.candidates[0]!;
    expect(reorder.diff.durationDeltaSeconds!).toBeLessThan(req.diff.durationDeltaSeconds!);
    const applied = applyOperations(trip, reorder.operations!);
    expect(applied.ok && JSON.stringify(applied.trip.days)).toBe(JSON.stringify(reorder.trip.days));
    expect(new Set(r.candidates.map(c => c.candidateId)).size).toBe(r.candidates.length);
  });

  it('offers the nearest unused place of the same kind, and maxAlternatives limits the count', async () => {
    const { preview } = mini(mkTrip(baseItems()));
    const ops: TripOperation[] = [{ op: 'update', itemId: 'a3', item: act('a3', 5, 120, 170) }];
    const r = await preview(ops);
    const swap = r.candidates.find(c => c.kind === 'swap')!;
    expect(swap).toBeDefined();
    // P5's nearest unused spot is P4 (P6 is farther); P3 is used by nobody after the edit but is nearest-after P4? P4 and P6 tie by distance, lower id wins
    expect(acts(swap.trip).find(a => a.activityId === 'a3').placeId).toBe('P4');
    expect((await preview(ops, { maxAlternatives: 1 })).candidates).toHaveLength(1);
  });
});

describe('A05 mixed mode: live legs, call budget and storage rules (fake fetch only)', () => {
  function liveMini(items: unknown[], routeBudget?: UserRouteBudget) {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ routes: [{ duration: '900s', distanceMeters: 4000, travelAdvisory: { transitFare: { currencyCode: 'JPY', units: '200' } } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'test-key' }, { fetch: fakeFetch, now: () => Date.UTC(2026, 9, 24) });
    return { urls, sources, ...mini(mkTrip(items), sources, 'mixed', routeBudget) };
  }
  const noLegs = (n: number) => Array.from({ length: n }, (_, i) => act(`b${i}`, (i % 6) + 1, i * 70, i * 70 + 50));

  it('spends at most 6 route calls, leaves the rest unknown, and never puts live details into the operations', async () => {
    const { urls, preview, db } = liveMini(noLegs(10));
    const rowsBefore = JSON.stringify(db.prepare('SELECT * FROM trips').all());
    const r = await preview([{ op: 'move', itemId: 'b0', toDayIndex: 0, toPosition: 9 }]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.length).toBeLessThanOrEqual(6);
    const c = r.candidates[0]!;
    const live = c.trip.days[0]!.items.filter((i): i is TravelLeg => i.type === 'leg');
    expect(live.length).toBeGreaterThan(0);
    expect(live.every(l => l.provenance?.source === 'google_routes' && l.provenance.mayStore === false)).toBe(true); // shown, flagged
    expect(c.unknown).toContain('legs');
    expect(acts(c.trip).some(a => a.start === null)).toBe(true); // out of budget -> untimed, not guessed
    // what may be written carries no Google route detail
    const written = (c.operations ?? []).flatMap(o => (o.op === 'add' || o.op === 'update') && o.item.type === 'leg' ? [o.item] : []);
    for (const l of written) expect(l).toMatchObject({ durationSeconds: null, fare: null, lineName: null, platform: null, provenance: null, dataStatus: 'unknown' });
    expect(JSON.stringify(c.operations)).not.toContain('google_routes');
    expect(c.warnings.some(w => w.includes('保存されません'))).toBe(true);
    // preview stored nothing
    expect(JSON.stringify(db.prepare('SELECT * FROM trips').all())).toBe(rowsBefore);
  });

  it('a second variant pass does not exceed the cap either', async () => {
    const { urls, preview } = liveMini(noLegs(5));
    await preview([{ op: 'update', itemId: 'b0', item: act('b0', 2, 0, 40) }], { maxAlternatives: 3 });
    expect(urls.length).toBeLessThanOrEqual(6);
  });
});

describe('A05 shift-only re-timing (B3)', () => {
  it('a later activity keeps its start after an earlier one is edited (nothing is pulled earlier)', async () => {
    const items = [act('a1', 1, 0, 50), act('a2', 2, 180, 230), act('a3', 3, 300, 350)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 30) }])).candidates[0]!;
    expect(acts(c.trip).map(a => [a.activityId, startMin(a)])).toEqual([['a1', 0], ['a2', 180], ['a3', 300]]);
    expect(c.warnings.some(w => w.includes('遅らせ'))).toBe(false);
  });

  it('removing the first activity does not pull the day earlier or compress gaps', async () => {
    const { preview } = mini(mkTrip(baseItems()));
    const c = (await preview([{ op: 'remove', itemId: 'a1' }])).candidates[0]!;
    expect(acts(c.trip).map(a => [a.activityId, startMin(a)])).toEqual([['a2', 60], ['a3', 120]]);
  });

  it('pushes later by the least needed and says so; the order stays as the operations specify', async () => {
    const { preview } = mini(mkTrip(baseItems()));
    const c = (await preview([{ op: 'update', itemId: 'a2', item: act('a2', 4, 60, 110) }])).candidates[0]!;
    expect(acts(c.trip).map(a => [a.activityId, startMin(a)])).toEqual([['a1', 0], ['a2', 80], ['a3', 140]]);
    expect(acts(c.trip)[1].end).toEqual(at(130)); // length kept
    expect(c.warnings.some(w => w.includes('a2') && w.includes('20分遅らせ'))).toBe(true);
  });

  it('an item that would run past midnight stays in place, untimed, with a warning (never moved into the evening)', async () => {
    const items = [act('a1', 1, 800, 845), act('a2', 2, 855, 895)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 5, 800, 845) }])).candidates[0]!;
    expect(acts(c.trip).map(a => a.activityId)).toEqual(['a1', 'a2']);
    expect(acts(c.trip)[1]).toMatchObject({ start: null, end: null });
    expect(c.warnings.some(w => w.includes('a2') && w.includes('収まらない'))).toBe(true);
  });

  it('a stop that would be closed after the push stays in place untimed with a warning', async () => {
    const places = [1, 2, 3, 4, 5, 6, 7].map(n => (n === 2 ? { ...place(2), openingHours: '9:00-10:50' } : place(n)));
    const { preview } = mini(mkTrip([act('a1', 1, 0, 50), act('a2', 2, 60, 110)], { places }));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 4, 0, 50) }])).candidates[0]!;
    expect(acts(c.trip).map(a => a.activityId)).toEqual(['a1', 'a2']);
    expect(acts(c.trip)[1]).toMatchObject({ start: null, end: null });
    expect(c.warnings.some(w => w.includes('営業時間'))).toBe(true);
  });

  it('only the reorder variant reorders and packs, and its summary says so', async () => {
    const items = [act('a1', 1, 0, 50), act('a2', 3, 70, 120), act('a3', 2, 130, 180)];
    const { preview } = mini(mkTrip(items));
    const r = await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 40) }]);
    expect(acts(r.candidates[0]!.trip).map(a => a.activityId)).toEqual(['a1', 'a2', 'a3']);
    expect(acts(r.candidates[0]!.trip).map(startMin)).toEqual([0, 70, 130]);
    expect(r.candidates.find(c => c.kind === 'reorder')!.summary).toContain('詰め直し');
  });

  it('a day with more than 5 movable stops gets no reorder variant (permutation cap)', async () => {
    const items = [1, 2, 3, 4, 5, 6].map((n, i) => act(`b${i}`, n, i * 70, i * 70 + 50));
    const { preview } = mini(mkTrip(items));
    const r = await preview([{ op: 'update', itemId: 'b0', item: act('b0', 1, 0, 40) }]);
    expect(r.candidates.map(c => c.kind)).not.toContain('reorder');
  });
});

describe('A05 timetable legs (B4)', () => {
  const service = { ...legOf(1, 2, 600, 200, 'svc'), lineName: 'X線', platform: '3', departure: at(50), arrival: at(60) };
  const items = () => [act('a1', 1, 0, 50), service, act('a2', 2, 60, 110), { ...legOf(2, 3, 600, null, 'plain'), departure: at(110), arrival: at(120) }, act('a3', 3, 120, 170)];

  it('when the time of a leg with line/platform changes, its times, line, platform and fare are dropped with a notice', async () => {
    const { preview } = mini(mkTrip(items()));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 70) }])).candidates[0]!;
    const svc = c.trip.days[0]!.items.find((i: any) => i.legId === 'svc') as TravelLeg;
    expect(svc).toMatchObject({ departure: null, arrival: null, lineName: null, platform: null, fare: null, durationSeconds: 600 });
    expect(c.warnings.some(w => w.includes('便が変わるため乗車情報は再確認'))).toBe(true);
    const plain = c.trip.days[0]!.items.find((i: any) => i.legId === 'plain') as TravelLeg;
    expect(plain.departure).not.toBeNull(); // no timetable fields: derived from the known duration
    expect(plain.lineName).toBeNull();
  });

  it('an unchanged leg keeps its service information verbatim', async () => {
    const { preview } = mini(mkTrip(items()));
    const c = (await preview([{ op: 'update', itemId: 'a3', item: act('a3', 3, 130, 180) }])).candidates[0]!;
    expect(c.trip.days[0]!.items.find((i: any) => i.legId === 'svc')).toEqual(service);
    expect(c.warnings.some(w => w.includes('便が変わる'))).toBe(false);
  });
});

describe('A05 diff equals PATCH diff (B1), validation state (O7), unsourced legs (O2), busy guard (O5)', () => {
  const reorderItems = () => [act('a1', 1, 0, 50), act('a2', 3, 70, 120), act('a3', 2, 130, 180)];
  const scenarios: [string, () => Trip, TripOperation[]][] = [
    ['same-area update', () => mkTrip(baseItems()), [{ op: 'update', itemId: 'a2', item: act('a2', 4, 60, 110) }]],
    ['reorder + swap', () => mkTrip(reorderItems()), [{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 40) }]],
    ['swap', () => mkTrip(baseItems()), [{ op: 'update', itemId: 'a3', item: act('a3', 5, 120, 170) }]],
  ];

  it.each(scenarios)('fixture: every candidate diff deep-equals the PATCH diff of its operations (%s)', async (_n, mk, ops) => {
    const first = await mini(mk()).preview(ops);
    expect(first.candidates.length).toBeGreaterThan(0);
    for (const c of first.candidates) {
      const m = mini(mk());
      const r = await m.patch(1, c.operations);
      expect(r.statusCode, r.payload).toBe(200);
      expect(r.json().diff).toEqual(c.diff);
      expect(r.json().trip.validationState).toBe(c.trip.validationState); // O7
      expect(c.trip.validationState).toBe('needs_revalidation');
      expect(r.json().trip.days).toEqual(c.trip.days);
    }
  });

  it('a title-only preview keeps the stored validation state', async () => {
    const c = (await mini(mkTrip(baseItems())).preview([{ op: 'set_title', title: 'N' }])).candidates[0]!;
    expect(c.trip.validationState).toBe('valid');
  });

  it('mixed: diff equals the PATCH diff (live details are not stored), displayOnly shows the fares, and the apply round trip stores no Google content', async () => {
    const items = Array.from({ length: 3 }, (_, i) => act(`b${i}`, i + 1, i * 70, i * 70 + 50));
    const live = (function () {
      const urls: string[] = [];
      const fakeFetch = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ routes: [{ duration: '900s', distanceMeters: 4000, travelAdvisory: { transitFare: { currencyCode: 'JPY', units: '200' } } }] }), { status: 200 }))) as unknown as typeof fetch;
      return createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: fakeFetch, now: () => Date.UTC(2026, 9, 24) });
    })();
    const m = mini(mkTrip(items), live, 'mixed');
    const r = await m.preview([{ op: 'move', itemId: 'b0', toDayIndex: 0, toPosition: 2 }]);
    const c = r.candidates[0]!;
    expect(c.trip.days[0]!.items.some((i: any) => i.provenance?.source === 'google_routes')).toBe(true);
    expect(c.displayOnly).toBeDefined();
    expect(c.displayOnly!.knownCostDelta.some(x => x.currency === 'JPY')).toBe(true);
    expect(c.diff.knownCostDelta.some(x => x.currency === 'JPY' && x.amountMinor === c.displayOnly!.knownCostDelta[0]!.amountMinor)).toBe(false);
    const res = await m.patch(r.baseRevision, c.operations);
    expect(res.statusCode, res.payload).toBe(200);
    expect(res.json().diff).toEqual(c.diff);
    expect(JSON.stringify(res.json().trip)).not.toContain('google_routes');
    expect(JSON.stringify(m.db.prepare('SELECT days_json FROM trips').all())).not.toContain('google_routes');
    const stored = Trip.parse(res.json().trip);
    expect(computeDiff(mkTrip(items), stored)).toEqual(c.diff);
  });

  it('a leg with a line or platform but no provenance is refused (422 RESTRICTED_ASSET) by PATCH and by the preview', async () => {
    const m = mini(mkTrip(baseItems()));
    const bad = { ...legOf(1, 3, 600, null, 'x1'), lineName: 'X', provenance: null, dataStatus: 'unknown' };
    const op = [{ op: 'add', dayIndex: 0, position: 1, item: bad }];
    for (const r of [await m.patch(1, op), await m.post({ expectedRevision: 1, operations: op })]) {
      expect(r.statusCode).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('RESTRICTED_ASSET');
    }
    const ok = await m.patch(1, [{ op: 'add', dayIndex: 0, position: 1, item: { ...bad, lineName: null } }]);
    expect(ok.statusCode).toBe(200);
  });

  it('one preview at a time per user, even in fixture mode', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => (release = res));
    const routes: RouteProvider = { route: async () => (await gate, { leg: null, reason: 'no_route' as const }) };
    const m = mini(mkTrip(baseItems()), { ...createContextSources({ providerMode: 'fixture' }), routes });
    const body = { expectedRevision: 1, operations: [{ op: 'update', itemId: 'a2', item: act('a2', 4, 60, 110) }] };
    const first = m.post(body);
    await new Promise(r => setTimeout(r, 20));
    const second = await m.post(body);
    expect(second.statusCode).toBe(429);
    expect(ApiError.parse(second.json()).code).toBe('RATE_LIMITED');
    release();
    expect((await first).statusCode).toBe(200);
    expect((await m.post(body)).statusCode).toBe(200);
  });
});

describe('per-user daily live route budget, shared by K05 and A05 (B2)', () => {
  it('counts calls per user per UTC day with a fake clock; another user is unaffected', () => {
    let t = Date.UTC(2026, 9, 24, 12);
    const b = createUserRouteBudget({ perDay: 3, now: () => t });
    expect([1, 2, 3, 4].map(() => b.take('u1'))).toEqual([true, true, true, false]);
    expect(b.remaining('u1')).toBe(0);
    expect(b.remaining('u2')).toBe(3);
    expect(b.take('u2')).toBe(true);
    t += 24 * 3600_000;
    expect(b.take('u1')).toBe(true);
  });

  it('LIVE_ROUTE_CALLS_PER_USER_PER_DAY: default 6, 0..20, invalid values refused at startup', () => {
    expect(liveRouteCallsPerUserFromEnv({})).toBe(6);
    expect(liveRouteCallsPerUserFromEnv({ LIVE_ROUTE_CALLS_PER_USER_PER_DAY: '20' })).toBe(20);
    expect(liveRouteCallsPerUserFromEnv({ LIVE_ROUTE_CALLS_PER_USER_PER_DAY: '0' })).toBe(0);
    for (const bad of ['21', '-1', 'abc', '1.5']) {
      expect(() => liveRouteCallsPerUserFromEnv({ LIVE_ROUTE_CALLS_PER_USER_PER_DAY: bad }), bad).toThrow(/LIVE_ROUTE_CALLS_PER_USER_PER_DAY/);
      expect(() => loadConfig({ SESSION_SECRET: 's'.repeat(40), LIVE_ROUTE_CALLS_PER_USER_PER_DAY: bad }), bad).toThrow(/LIVE_ROUTE_CALLS_PER_USER_PER_DAY/);
    }
  });

  it('K05 and A05 draw on the same counter; when it is used up the pair is unknown with a warning, not an error', async () => {
    const budget = createUserRouteBudget({ perDay: 3 });
    const urls: string[] = [];
    const fakeFetch = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ routes: [{ duration: '600s', distanceMeters: 3000 }] }), { status: 200 }))) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: fakeFetch, now: () => Date.UTC(2026, 9, 24) });
    // K05: two live legs for user_a
    const k05 = Fastify({ logger: false });
    k05.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'user_a', displayName: 'A' }));
    registerPlanningContext(k05, { providerMode: 'mixed' } as never, { sources, routeBudget: budget });
    closers.push(k05);
    const q = (to: string) => ({ fromPlaceId: 'fx_kanazawa_station', toPlaceId: to, departureUtc: '2026-11-01T00:00:00Z', mode: 'car' });
    const kr = await k05.inject({ method: 'POST', url: '/api/v1/planning-context', payload: { area: '金沢', transportMode: 'car', legs: [q('fx_kenrokuen'), q('fx_sushi')] } });
    expect(kr.statusCode).toBe(200);
    expect(urls).toHaveLength(2);
    expect(budget.remaining('user_a')).toBe(1);
    // A05 for the same user: only one more live call is possible
    const items = Array.from({ length: 4 }, (_, i) => act(`b${i}`, i + 1, i * 70, i * 70 + 50));
    const m = mini(mkTrip(items), sources, 'mixed', budget);
    const r = await m.preview([{ op: 'move', itemId: 'b0', toDayIndex: 0, toPosition: 3 }]);
    expect(urls).toHaveLength(3);
    const c = r.candidates[0]!;
    expect(c.warnings.some(w => w.includes('上限'))).toBe(true);
    expect(c.unknown).toContain('legs');
    expect(acts(c.trip).some(a => a.start === null)).toBe(true);
    expect(budget.remaining('user_a')).toBe(0);
    expect(budget.remaining('user_b')).toBe(3);
    // K05 after exhaustion: 200 with the leg unknown
    const again = await k05.inject({ method: 'POST', url: '/api/v1/planning-context', payload: { area: '金沢', transportMode: 'car', legs: [q('fx_kenrokuen')] } });
    expect(again.statusCode).toBe(200);
    expect(again.json().legs).toEqual([]);
    expect(again.json().unknown).toContain('legs');
    expect(urls).toHaveLength(3);
  });
});

describe('A05 shift-only edge cases (B5, anchors, untimed stops)', () => {
  it('a skipped activity is kept verbatim, gets no legs, and does not hide the real previous stop', async () => {
    const items = [act('a1', 1, 0, 50), act('s', 5, 60, 110, { status: 'skipped' }), act('a3', 2, 120, 170)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 40) }])).candidates[0]!;
    const day = c.trip.days[0]!.items as any[];
    expect(day.find(i => i.activityId === 's')).toEqual(items[1]);
    const legs = day.filter(i => i.type === 'leg');
    expect(legs.map(l => [l.fromPlaceId, l.toPlaceId])).toEqual([['P1', 'P2']]);
    expect(acts(c.trip).find(a => a.activityId === 'a3').start).toEqual(at(120));
    expect(c.affectedSegments.every(s => s.fromItemId !== 's' && s.toItemId !== 's')).toBe(true);
    // reachability is measured from a1, not from the skipped stop: pushing a1 later pushes a3
    const late = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 115) }])).candidates[0]!;
    expect(startMin(acts(late.trip).find(a => a.activityId === 'a3'))).toBe(125);
  });

  it('a pushed stop that would run into the next fixed activity becomes untimed (does not fit)', async () => {
    const items = [act('a1', 1, 0, 50), act('a2', 2, 60, 110), act('f', 3, 120, 170, { fixed: true })];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a2', item: act('a2', 5, 60, 110) }])).candidates[0]!;
    expect(acts(c.trip).find(a => a.activityId === 'a2')).toMatchObject({ start: null, end: null });
    expect(acts(c.trip).find(a => a.activityId === 'f').start).toEqual(at(120));
    expect(c.warnings.some(w => w.includes('a2') && w.includes('収まらない'))).toBe(true);
  });

  it('after an untimed stop, reachability is checked from the last timed stop', async () => {
    const items = [act('a1', 1, 0, 50), act('u', 3, null, null), act('a3', 2, 55, 100)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 60) }])).candidates[0]!;
    expect(startMin(acts(c.trip).find(a => a.activityId === 'a3'))).toBe(70); // 60 + 10 min ride P1 -> P2
    expect(acts(c.trip).find(a => a.activityId === 'u')).toMatchObject({ start: null, end: null });
  });

  it('a fixed activity ends the untimed chain: later stops resume from its end', async () => {
    const items = [act('a1', 1, 0, 50), act('a2', 7, 60, 110), act('f', 3, 150, 200, { fixed: true }), act('a4', 2, 210, 260)];
    const { preview } = mini(mkTrip(items));
    const c = (await preview([{ op: 'update', itemId: 'a1', item: act('a1', 1, 0, 55) }])).candidates[0]!;
    expect(acts(c.trip).find(a => a.activityId === 'a2')).toMatchObject({ start: null, end: null });
    expect(acts(c.trip).find(a => a.activityId === 'a4').start).toEqual(at(210));
    expect(c.warnings.some(w => w.includes('a4'))).toBe(false);
  });
});

describe('per-user budget is charged only when the call goes out (O-c)', () => {
  it('a call the global CallBudget refuses costs the user nothing; one that goes out costs one unit', async () => {
    const { CallBudget, DailyQuota, Gate } = await import('@tkb/travel-data');
    const { limitRoutesPerUser } = await import('../src/trips/generation/live-route-budget.ts');
    const budget = createUserRouteBudget({ perDay: 5 });
    const inner: RouteProvider = { route: async (_r, b) => ({ leg: (await b.run('sku', 'k', async () => legOf(1, 2, 600))) as TravelLeg, reason: null }) };
    const wrapped = limitRoutesPerUser(inner, 'u1', budget);
    const req = { from: place(1), to: place(2), departureUtc: '2026-11-01T00:00:00Z', mode: 'car' } as never;
    const none = new CallBudget({ maxCalls: 0, quota: new DailyQuota({ sku: 10 }), gate: new Gate(1) });
    await expect(wrapped.route(req, none)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(budget.remaining('u1')).toBe(5);
    const one = new CallBudget({ maxCalls: 1, quota: new DailyQuota({ sku: 10 }), gate: new Gate(1) });
    expect((await wrapped.route(req, one)).leg).not.toBeNull();
    expect(budget.remaining('u1')).toBe(4);
    expect(wrapped.exhausted()).toBe(false);
  });
  it('a user with no allowance left never touches the shared DailyQuota or the per-input cap (B6)', async () => {
    const { CallBudget, DailyQuota, Gate } = await import('@tkb/travel-data');
    const { limitRoutesPerUser } = await import('../src/trips/generation/live-route-budget.ts');
    const budget = createUserRouteBudget({ perDay: 0 });
    let fetched = 0;
    const inner: RouteProvider = { route: async (_r, b) => ({ leg: (await b.run('sku', 'k', async () => { fetched++; return legOf(1, 2, 600); })) as TravelLeg, reason: null }) };
    const wrapped = limitRoutesPerUser(inner, 'u1', budget);
    const req = { from: place(1), to: place(2), departureUtc: '2026-11-01T00:00:00Z', mode: 'car' } as never;
    const quota = new DailyQuota({ sku: 10 });
    const cb = new CallBudget({ maxCalls: 5, quota, gate: new Gate(1) });
    for (let i = 0; i < 3; i++) await expect(wrapped.route(req, cb)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMIT' });
    expect(fetched).toBe(0);
    expect(quota.remaining('sku')).toBe(10);
    expect(cb.callsUsed).toBe(0);
    expect(wrapped.exhausted()).toBe(true);
  });
});
