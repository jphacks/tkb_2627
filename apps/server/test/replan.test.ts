// A06 POST /api/v1/trips/:id/replan: smoke tests only (fixture and fake route sources; no real provider call).
import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { Trip, type PlaceInfo, type TravelLeg } from '@tkb/contracts';
import { createUser, getTripForOwner, insertTrip, migrate, openDatabase } from '@tkb/db';
import { FixtureRouteProvider, type RouteProvider, type RouteRequest } from '@tkb/travel-data';
import type { ReplanResult } from '../src/trips/replan/index.ts';
import { registerTrips } from '../src/trips/index.ts';
import { createUserRouteBudget } from '../src/trips/generation/live-route-budget.ts';
import { createContextSources, type ContextSources } from '../src/trips/generation/sources.ts';

const tz = 'Asia/Tokyo';
const closers: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!.close();
});

const fixProv = { source: 'fixture', fetchedAt: null, attribution: null, maySendToModel: true, mayStore: true, mayExport: true, retainUntil: null };
const place = (n: number): PlaceInfo => ({
  placeId: `P${n}`, name: `Place ${n}`, kind: 'spot', location: { lat: 35 + n * 0.05, lng: 139 }, timeZone: tz,
  openingHours: null, description: null, photo: null, dataStatus: 'fixture', provenance: fixProv,
});
/** Minutes after 09:00 JST on 2026-11-01. */
const at = (min: number) => ({ utc: new Date(Date.UTC(2026, 10, 1, 0, 0) + min * 60_000).toISOString().replace(/\.000Z$/, 'Z'), timeZone: tz });
const atMs = (min: number) => Date.parse(at(min).utc);
const act = (id: string, p: number, from: number | null, to: number | null, extra: object = {}): any => ({
  type: 'activity', activityId: id, kind: 'visit', title: id, placeId: `P${p}`, areaName: null,
  start: from === null ? null : at(from), end: to === null ? null : at(to), fixed: false, status: 'planned',
  cost: null, costStatus: 'unknown', privateNotes: null, ...extra,
});
const legOf = (a: number, b: number, sec: number): TravelLeg => ({
  type: 'leg', legId: `M${a}_${b}`, mode: 'transit', fromPlaceId: `P${a}`, toPlaceId: `P${b}`, departure: null, arrival: null, durationSeconds: sec,
  lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'fixture', provenance: fixProv,
});
/** |i-j| x 10 minutes between P1..P5. */
const MATRIX: TravelLeg[] = [];
for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) if (i !== j) MATRIX.push(legOf(i, j, Math.abs(i - j) * 600));

const mkTrip = (items: unknown[]) =>
  Trip.parse({
    schemaVersion: 1, tripId: 't_a06', ownerId: 'user_a', title: 'T', revision: 1,
    constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: tz, transportMode: 'transit' },
    days: [{ date: '2026-11-01', timeZone: tz, items }, { date: '2026-11-02', timeZone: tz, items: [{ ...act('d2', 1, 60, 110), start: { utc: '2026-11-02T01:00:00Z', timeZone: tz }, end: { utc: '2026-11-02T01:50:00Z', timeZone: tz } }] }],
    places: [1, 2, 3, 4, 5].map(place), validationState: 'valid', warnings: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z',
  });

function mini(items: unknown[], nowMin: number | string, routes: RouteProvider = new FixtureRouteProvider(MATRIX)) {
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: 'x', displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  insertTrip(db, 'user_a', mkTrip(items), '2026-10-01T00:00:00Z');
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'user_a', displayName: 'A' }));
  const sources: ContextSources = { ...createContextSources({ providerMode: 'fixture' }), routes };
  const now = typeof nowMin === 'number' ? atMs(nowMin) : Date.parse(nowMin);
  registerTrips(app, db, { providerMode: 'fixture' } as never, { replan: { sources, routeBudget: createUserRouteBudget({ perDay: 20 }), now: () => now } });
  closers.push(app);
  const post = (payload: unknown, id = 't_a06') => app.inject({ method: 'POST', url: `/api/v1/trips/${id}/replan`, payload: payload as object });
  const patch = (revision: number, operations: unknown) => app.inject({ method: 'PATCH', url: '/api/v1/trips/t_a06', payload: { expectedRevision: revision, operations } as object });
  return { db, post, patch };
}
const acts = (t: Trip, d = 0) => t.days[d]!.items.filter(i => i.type === 'activity') as any[];
const byId = (t: Trip, id: string) => acts(t).find(a => a.activityId === id);
const startMin = (a: any) => (Date.parse(a.start.utc) - atMs(0)) / 60000;
const unavailable = { kind: 'unavailable', reason: 'denied' } as const;

/** a1(P1) done, a2(P2) was planned 10:00 (min 60), a3(P3) 11:00. Now is 10:30 (min 90): the connection was missed. */
const items = () => [act('a1', 1, 0, 30), act('a2', 2, 35, 85), act('a3', 3, 120, 170)];

describe('A06 replan smoke', () => {
  it('re-times what is left from now, starting at the last completed place, and PATCH agrees with the preview', async () => {
    const { post, patch, db } = mini(items(), 90);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const res = r.json() as ReplanResult;
    const c = res.candidates[0]!;
    expect(res.start).toEqual({ kind: 'last_completed', placeId: 'P1' });
    expect(byId(c.trip, 'a1').status).toBe('completed');
    expect(startMin(byId(c.trip, 'a2'))).toBe(100); // now (90) + 10 min P1 -> P2
    expect(startMin(byId(c.trip, 'a3'))).toBeGreaterThanOrEqual(160);
    expect(c.retimed).toEqual(['a2', 'a3']);
    expect(c.operations).not.toBeNull();
    expect(getTripForOwner(db, 't_a06', 'user_a')!.revision).toBe(1); // preview wrote nothing
    const p = await patch(1, c.operations);
    expect(p.statusCode, p.payload).toBe(200);
    expect(p.json().diff).toEqual(c.diff);
    expect(byId(p.json().trip, 'a1').status).toBe('completed');
    expect(p.json().revision).toBe(2);
  });

  it('keeps a reservation unchanged and reports it as missed when it is over', async () => {
    const f1 = act('f1', 2, 60, 110, { fixed: true });
    const { post } = mini([act('a1', 1, 0, 50), f1, act('a3', 3, 120, 170)], 150);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    const c = (r.json() as ReplanResult).candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'missed' });
    expect(c.operations?.some(o => (o.op === 'update' || o.op === 'remove') && o.itemId === 'f1')).toBe(false);
  });

  it('never stores or echoes the current location (coords without a known route fall back to no start)', async () => {
    const { post, patch, db } = mini(items(), 90);
    const r = await post({ expectedRevision: 1, location: { kind: 'coords', point: { lat: 12.3456, lng: 98.7654 } }, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.payload).not.toContain('12.3456');
    expect(r.payload).not.toContain('98.7654');
    const res = r.json() as ReplanResult;
    expect(res.start).toEqual({ kind: 'none', placeId: null });
    expect(JSON.stringify(res.candidates[0]!.trip)).not.toContain('_current_location');
    expect(JSON.stringify(res.candidates[0]!.operations)).not.toContain('_current_location');
    await patch(1, res.candidates[0]!.operations);
    expect(JSON.stringify(getTripForOwner(db, 't_a06', 'user_a'))).not.toContain('_current_location');
  });

  it('refuses bad requests: unknown key, unknown or leg id, unknown place, stale revision, now outside the trip, missing trip', async () => {
    const { post } = mini(items(), 90);
    const ok = { expectedRevision: 1, location: unavailable };
    expect((await post({ ...ok, extra: 1 })).statusCode).toBe(422);
    expect((await post({ ...ok, completedActivityIds: ['nope'] })).statusCode).toBe(422);
    expect((await post({ ...ok, location: { kind: 'place', placeId: 'P9' } })).statusCode).toBe(422);
    const stale = await post({ ...ok, expectedRevision: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 2, currentRevision: 1 } });
    expect((await post(ok, 'missing')).statusCode).toBe(404);
    const out = mini(items(), '2026-12-01T00:00:00Z');
    const o = await out.post(ok);
    expect(o.statusCode).toBe(422);
    expect(o.json()).toMatchObject({ code: 'CONSTRAINT_UNSATISFIED', details: { reason: 'outside_trip' } });
  });

  const LATE = (t: string) => `「${t}」までの公共交通の経路が見つかりませんでした（終電後の可能性があります）。徒歩・タクシーなどはご自身で確認してください。`;

  it('B1: a live transit answer that is tomorrow\'s first train is treated as no route (終電後)', async () => {
    const nextMorning: RouteProvider = {
      route: async (q: RouteRequest) => ({
        leg: { ...legOf(1, 2, 1800), legId: 'live1', dataStatus: 'verified', departure: { utc: '2026-11-02T20:30:00Z', timeZone: tz }, arrival: { utc: '2026-11-02T21:00:00Z', timeZone: tz } },
        reason: q.mode === 'transit' ? null : null,
      }),
    };
    const { post } = mini([act('a1', 1, 700, 740), act('a2', 2, 745, 775)], 850, nextMorning);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    const c = (r.json() as ReplanResult).candidates[0]!;
    expect(byId(c.trip, 'a2').start).toBeNull();
    expect(c.warnings).toContain(LATE('a2'));
    expect(c.unknown).toContain('legs');
  });

  it('B2: routes are looked up at the projected time, so a stop pushed past 22:00 triggers 終電後', async () => {
    const asked: string[] = [];
    const lateAware: RouteProvider = {
      route: async (q: RouteRequest) => {
        asked.push(`${q.from.placeId}>${q.to.placeId}@${q.departureUtc}`);
        const m = MATRIX.find(l => l.fromPlaceId === q.from.placeId && l.toPlaceId === q.to.placeId);
        return Date.parse(q.departureUtc) >= atMs(780) || !m ? { leg: null, reason: 'no_route' as const } : { leg: structuredClone(m), reason: null };
      },
    };
    // a2 was 21:00-21:30, a3 21:35-21:50; now is 21:55, so both are re-timed: a2 22:05-22:35, then P2 -> P3 leaves 22:35.
    const { post } = mini([act('a1', 1, 660, 700), act('a2', 2, 720, 750), act('a3', 3, 755, 770)], 775, lateAware);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    const c = (r.json() as ReplanResult).candidates[0]!;
    expect(asked).toContain(`P2>P3@${at(815).utc}`);
    expect(byId(c.trip, 'a3').start).toBeNull();
    expect(c.warnings).toContain(LATE('a3'));
    expect(c.unknown).toContain('legs');
  });

  it('N1: a reservation between stops gets its legs (f1 unreachable, a2 still placed after it)', async () => {
    const f1 = act('f1', 5, 120, 150, { fixed: true });
    const { post } = mini([act('a1', 1, 0, 30), act('a2', 2, 35, 65), f1], 100);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    const c = (r.json() as ReplanResult).candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'unreachable' });
    expect(byId(c.trip, 'a2').start).not.toBeNull();
    expect(c.untimed).toEqual([]);
  });

  it('N4: completedActivityIds on another day are refused', async () => {
    const { post } = mini(items(), 90);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['d2'] });
    expect(r.statusCode).toBe(422);
  });

  it('N5: a stop completed ahead of time keeps its time without overlap warnings', async () => {
    const { post } = mini([act('a1', 1, 0, 30), act('a2', 2, 35, 85), act('a3', 3, 300, 330)], 90);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1', 'a3'] });
    expect(r.statusCode, r.payload).toBe(200);
    const c = (r.json() as ReplanResult).candidates[0]!;
    expect(byId(c.trip, 'a3')).toEqual({ ...act('a3', 3, 300, 330), status: 'completed' });
    expect(c.warnings.filter(w => w.includes('重なって') || w.includes('始まります') || w.includes('収まりません'))).toEqual([]);
  });

  it('N6: a planned stop that is under way now stays as it is and the rest starts after it', async () => {
    const a2 = act('a2', 2, 80, 110);
    const { post } = mini([act('a1', 1, 0, 30), a2, act('a3', 3, 120, 150)], 90);
    const r = await post({ expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] });
    expect(r.statusCode, r.payload).toBe(200);
    const res = r.json() as ReplanResult;
    expect(res.start).toEqual({ kind: 'ongoing', placeId: 'P2' });
    expect(byId(res.candidates[0]!.trip, 'a2')).toEqual(a2);
    expect(startMin(byId(res.candidates[0]!.trip, 'a3'))).toBeGreaterThanOrEqual(120);
  });
});
