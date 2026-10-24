// A05 POST /api/v1/trips/:id/alternatives: preview only, fixture and fake-fetch sources (no real provider call).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { ApiError, Trip, type PlaceInfo, type TravelLeg, type TripOperation } from '@tkb/contracts';
import { createUser, getTripForOwner, insertTrip, migrate, openDatabase } from '@tkb/db';
import { FixtureRouteProvider } from '@tkb/travel-data';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { registerAlternatives, type AlternativesResult } from '../src/trips/alternatives/index.ts';
import { applyOperations } from '../src/trips/operations.ts';
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
function mini(trip: Trip, sources: ContextSources = { ...createContextSources({ providerMode: 'fixture' }), routes: new FixtureRouteProvider(MATRIX) }, mode: 'fixture' | 'mixed' = 'fixture') {
  const db = openDatabase(':memory:');
  migrate(db);
  seedUsers(db);
  insertTrip(db, 'user_a', trip, '2026-10-01T00:00:00Z');
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'user_a', displayName: 'A' }));
  registerAlternatives(app, db, { providerMode: mode } as never, { sources });
  closers.push(app);
  const post = async (payload: unknown, id = trip.tripId) => app.inject({ method: 'POST', url: `/api/v1/trips/${id}/alternatives`, payload: payload as object });
  const preview = async (operations: TripOperation[], extra: object = {}) => {
    const r = await post({ expectedRevision: 1, operations, ...extra });
    expect(r.statusCode, r.payload).toBe(200);
    return r.json() as AlternativesResult;
  };
  return { app, db, post, preview };
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
  function liveMini(items: unknown[]) {
    const urls: string[] = [];
    const fakeFetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ routes: [{ duration: '900s', distanceMeters: 4000 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'test-key' }, { fetch: fakeFetch });
    return { urls, ...mini(mkTrip(items), sources, 'mixed') };
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
