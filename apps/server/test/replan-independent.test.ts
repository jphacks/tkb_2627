// A06 POST /api/v1/trips/:id/replan: independent verification (test-author). Fixture and fake sources only, no live call.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ApiError, Trip, type PlaceInfo, type TravelLeg } from '@tkb/contracts';
import { createUser, getTripForOwner, insertTrip, migrate, openDatabase } from '@tkb/db';
import { FixtureRouteProvider, type RouteProvider } from '@tkb/travel-data';
import { validateSchedule } from '@tkb/planner';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import type { ReplanResult } from '../src/trips/replan/index.ts';
import { registerTrips } from '../src/trips/index.ts';
import { createUserRouteBudget, type UserRouteBudget } from '../src/trips/generation/live-route-budget.ts';
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
const place = (n: number): PlaceInfo => ({
  placeId: `P${n}`, name: `Place ${n}`, kind: 'spot', location: { lat: 35.1111 + n * 0.0123, lng: 139.2222 + n * 0.0071 }, timeZone: tz,
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
const legOf = (a: number | string, b: number | string, sec: number): TravelLeg => ({
  type: 'leg', legId: `M${a}_${b}`, mode: 'transit', fromPlaceId: typeof a === 'number' ? `P${a}` : a, toPlaceId: typeof b === 'number' ? `P${b}` : b, departure: null, arrival: null, durationSeconds: sec,
  lineName: null, platform: null, transfers: null, fare: null, dataStatus: 'fixture', provenance: fixProv,
});
/** |i-j| x 10 minutes between P1..P5. */
const MATRIX: TravelLeg[] = [];
for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) if (i !== j) MATRIX.push(legOf(i, j, Math.abs(i - j) * 600));

const day2Item = () => act('d2', 1, 60, 110);
const mkTrip = (items: unknown[], extra: object = {}) =>
  Trip.parse({
    schemaVersion: 1, tripId: 't_a06', ownerId: 'user_a', title: 'T', revision: 1,
    constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: tz, transportMode: 'transit' },
    days: [{ date: '2026-11-01', timeZone: tz, items }, { date: '2026-11-02', timeZone: tz, items: [{ ...day2Item(), start: { utc: '2026-11-02T01:00:00Z', timeZone: tz }, end: { utc: '2026-11-02T01:50:00Z', timeZone: tz } }] }],
    places: [1, 2, 3, 4, 5].map(place), validationState: 'valid', warnings: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', ...extra,
  });
const fixtureSources = (routes: RouteProvider | null = new FixtureRouteProvider(MATRIX)): ContextSources => ({ ...createContextSources({ providerMode: 'fixture' }), routes });

interface MiniOpts { sources?: ContextSources; routeBudget?: UserRouteBudget; mode?: 'fixture' | 'mixed' }
function mini(items: unknown[], nowMin: number | string, o: MiniOpts = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  createUser(db, { id: 'user_a', loginId: 'user-a', passwordHash: 'x', displayName: 'A', createdAt: '2026-10-24T03:00:00Z' });
  insertTrip(db, 'user_a', mkTrip(items), '2026-10-01T00:00:00Z');
  const app = Fastify({ logger: false });
  app.decorate('authenticate', async (req: { actor?: unknown }) => void (req.actor = { userId: 'user_a', displayName: 'A' }));
  const now = typeof nowMin === 'number' ? atMs(nowMin) : Date.parse(nowMin);
  registerTrips(app, db, { providerMode: 'fixture' } as never, { replan: { sources: o.sources ?? fixtureSources(), routeBudget: o.routeBudget ?? createUserRouteBudget({ perDay: 20 }), now: () => now } });
  closers.push(app);
  const post = (payload: unknown, id = 't_a06') => app.inject({ method: 'POST', url: `/api/v1/trips/${id}/replan`, payload: payload as object });
  const patch = (revision: number, operations: unknown) => app.inject({ method: 'PATCH', url: '/api/v1/trips/t_a06', payload: { expectedRevision: revision, operations } as object });
  const stored = () => getTripForOwner(db, 't_a06', 'user_a')!;
  const rows = () => JSON.stringify(['trips', 'trip_versions', 'plan_batches'].map(t => db.prepare(`SELECT * FROM ${t}`).all()));
  const replan = async (body: object) => {
    const r = await post({ expectedRevision: 1, ...body });
    expect(r.statusCode, r.payload).toBe(200);
    return { raw: r.payload, res: r.json() as ReplanResult, headers: r.headers };
  };
  return { db, app, post, patch, stored, rows, replan };
}
const acts = (t: Trip, d = 0) => t.days[d]!.items.filter(i => i.type === 'activity') as any[];
const legsOf = (t: Trip, d = 0) => t.days[d]!.items.filter(i => i.type === 'leg') as TravelLeg[];
const byId = (t: Trip, id: string) => acts(t).find(a => a.activityId === id);
const startMin = (a: any) => (Date.parse(a.start.utc) - atMs(0)) / 60000;
const unavailable = { kind: 'unavailable', reason: 'denied' } as const;
const items = () => [act('a1', 1, 0, 30), act('a2', 2, 35, 85), act('a3', 3, 120, 170)];
const touchesFixed = (ops: any[] | null, id: string) => (ops ?? []).some(o => (o.op === 'update' || o.op === 'remove') && o.itemId === id);

/** Applying `operations` with PATCH must give exactly the previewed diff and days. */
async function expectPatchMatches(m: ReturnType<typeof mini>, res: ReplanResult) {
  const c = res.candidates[0]!;
  expect(c.operations).not.toBeNull();
  const p = await m.patch(res.baseRevision, c.operations);
  expect(p.statusCode, p.payload).toBe(200);
  expect(p.json().diff).toEqual(c.diff);
  expect(p.json().revision).toBe(res.baseRevision + 1);
  return p.json().trip as Trip;
}

describe('乗り遅れ (missed connection)', () => {
  it('re-times the planned stops from now, PATCH diff equals the preview diff, other day byte-identical', async () => {
    const m = mini(items(), 90);
    const before = JSON.stringify(m.stored().days[1]);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(res.dayIndex).toBe(0);
    expect(byId(c.trip, 'a1').status).toBe('completed');
    expect(startMin(byId(c.trip, 'a2'))).toBe(100);
    expect(startMin(byId(c.trip, 'a3'))).toBeGreaterThanOrEqual(startMin(byId(c.trip, 'a2')) + 50 + 10);
    expect(c.kept.completed).toEqual(['a1']);
    expect(JSON.stringify(c.trip.days[1])).toBe(before);
    const stored = await expectPatchMatches(m, res);
    expect(byId(stored, 'a1').status).toBe('completed');
    expect(JSON.stringify(stored.days[1])).toBe(before);
    expect(byId(stored, 'a2').start).toEqual(byId(c.trip, 'a2').start);
  });

  it('a completed activity keeps its original object apart from the status', async () => {
    const m = mini(items(), 90);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    expect(byId(res.candidates[0]!.trip, 'a1')).toEqual({ ...items()[0], status: 'completed' });
  });

  it('missedActivityIds on a fixed future reservation: unchanged, reported missed, no op touches it', async () => {
    const f1 = act('f1', 3, 120, 170, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), act('a2', 2, 60, 110), f1], 100);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'], missedActivityIds: ['f1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'missed' });
    expect(c.warnings).toContain('予約「f1」の時刻を過ぎています。予約先に確認してください。');
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
    await expectPatchMatches(m, res);
    expect(byId(m.stored(), 'f1')).toEqual(f1);
  });

  it('an overdue fixed item that is not completed is reported missed without being listed', async () => {
    const f1 = act('f1', 2, 60, 110, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), f1, act('a3', 3, 120, 170)], 150);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'missed' });
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
  });

  it('an operation (destination change) is applied before re-timing and ends up in the operations', async () => {
    const m = mini(items(), 90);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'], operations: [{ op: 'remove', itemId: 'a3' }] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'a3')).toBeUndefined();
    expect(c.operations).toContainEqual({ op: 'remove', itemId: 'a3' });
    const stored = await expectPatchMatches(m, res);
    expect(byId(stored, 'a3')).toBeUndefined();
  });
});

describe('終電後 (after the last train)', () => {
  const noRoute: RouteProvider = { route: async () => ({ leg: null, reason: 'no_route' as const }) };
  /** a1 done, a2 planned (both over by now), fixed lodging 23:30-23:59. Now 23:10 JST. */
  const lateItems = () => [act('a1', 1, 700, 740), act('a2', 2, 745, 775), act('lodge', 4, 870, 899, { fixed: true, kind: 'lodging' })];

  it('untimed remaining stops with the warning, unknown includes legs, nothing invented, fixed lodging kept with travel_unknown', async () => {
    const m = mini(lateItems(), 850, { sources: fixtureSources(noRoute) });
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    const a2 = byId(c.trip, 'a2');
    expect(a2.start).toBeNull();
    expect(a2.end).toBeNull();
    expect(c.untimed.map(u => u.activityId)).toContain('a2');
    expect(c.warnings).toContain('「a2」までの公共交通の経路が見つかりませんでした（終電後の可能性があります）。徒歩・タクシーなどはご自身で確認してください。');
    expect(c.unknown).toContain('legs');
    for (const l of legsOf(c.trip)) {
      expect(l.fare).toBeNull();
      expect(l.platform).toBeNull();
      expect(l.durationSeconds).toBeNull();
    }
    expect(res.startLeg === null || (res.startLeg.fare === null && res.startLeg.platform === null && res.startLeg.durationSeconds === null)).toBe(true);
    expect(byId(c.trip, 'lodge')).toEqual(lateItems()[2]);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'lodge', reason: 'travel_unknown' });
    expect(touchesFixed(c.operations, 'lodge')).toBe(false);
  });

  it('the late warning is not given before 22:00 (a plain no_route is not blamed on the last train)', async () => {
    const m = mini([act('a1', 1, 0, 30), act('a2', 2, 35, 85)], 90, { sources: fixtureSources(noRoute) });
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(c.warnings.some(w => w.includes('終電後'))).toBe(false);
    expect(byId(c.trip, 'a2').start).toBeNull();
  });

  it('now past 23:59: remaining stops do not fit and stay untimed, the next day is unchanged', async () => {
    const m = mini([act('a1', 1, 780, 830), act('a2', 2, 840, 890), act('a3', 3, 891, 899)], 899.5);
    const before = JSON.stringify(m.stored().days[1]);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(res.dayIndex).toBe(0);
    expect(c.untimed).toEqual([{ activityId: 'a2', reason: 'does_not_fit' }, { activityId: 'a3', reason: 'does_not_fit' }]);
    expect(byId(c.trip, 'a2').start).toBeNull();
    expect(byId(c.trip, 'a3').start).toBeNull();
    expect(JSON.stringify(c.trip.days[1])).toBe(before);
    const stored = await expectPatchMatches(m, res);
    expect(JSON.stringify(stored.days[1])).toBe(before);
  });
});

describe('位置拒否 (location denied or unusable)', () => {
  const assertNoLocationLeak = (raw: string, c: ReplanResult['candidates'][number], coords: string[] = []) => {
    for (const v of coords) expect(raw).not.toContain(v);
    expect(JSON.stringify(c.trip)).not.toContain('_current_location');
    expect(JSON.stringify(c.operations)).not.toContain('_current_location');
  };

  for (const reason of ['denied', 'error', 'skipped'] as const) {
    it(`unavailable (${reason}) with a completed stop starts from its place, with the warning`, async () => {
      const m = mini(items(), 90);
      const { res, raw } = await m.replan({ location: { kind: 'unavailable', reason }, completedActivityIds: ['a1'] });
      expect(res.start).toEqual({ kind: 'last_completed', placeId: 'P1' });
      expect(res.candidates[0]!.warnings).toContain('現在地が使えないため、最後に完了した予定の場所から計算しました。');
      assertNoLocationLeak(raw, res.candidates[0]!);
    });
  }

  it('unavailable with nothing completed: start none, warning, unknown includes start', async () => {
    const m = mini(items(), 90);
    const { res, raw } = await m.replan({ location: unavailable });
    expect(res.start).toEqual({ kind: 'none', placeId: null });
    expect(res.candidates[0]!.warnings).toContain('現在地が分からないため、最初の移動時間は含めていません。');
    expect(res.candidates[0]!.unknown).toContain('start');
    assertNoLocationLeak(raw, res.candidates[0]!);
    expect(await m.patch(1, res.candidates[0]!.operations)).toMatchObject({ statusCode: 200 });
    expect(JSON.stringify(m.stored())).not.toContain('_current_location');
  });

  it('a place not in the trip is refused with 422', async () => {
    const m = mini(items(), 90);
    const r = await m.post({ expectedRevision: 1, location: { kind: 'place', placeId: 'P9' } });
    expect(r.statusCode).toBe(422);
    expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
  });

  it('a place in the trip is used as the start', async () => {
    const m = mini(items(), 90);
    const { res } = await m.replan({ location: { kind: 'place', placeId: 'P4' }, completedActivityIds: ['a1'] });
    expect(res.start).toEqual({ kind: 'place', placeId: 'P4' });
    expect(startMin(byId(res.candidates[0]!.trip, 'a2'))).toBe(110); // 90 + P4 -> P2 (20 min)
  });

  it('coords with no known route (fixture) fall back to none; the coordinates are never echoed, stored or put in ops', async () => {
    const m = mini(items(), 90);
    const { res, raw } = await m.replan({ location: { kind: 'coords', point: { lat: 12.3456, lng: 98.7654 } }, completedActivityIds: ['a1'] });
    expect(res.start).toEqual({ kind: 'none', placeId: null });
    expect(res.startLeg).toBeNull();
    assertNoLocationLeak(raw, res.candidates[0]!, ['12.3456', '98.7654']);
    await m.patch(1, res.candidates[0]!.operations);
    const dump = JSON.stringify(m.stored()) + m.rows();
    expect(dump).not.toContain('_current_location');
    expect(dump).not.toContain('12.3456');
    expect(dump).not.toContain('98.7654');
  });

  it('coords with a known route: start coords, startLeg shown for display only, nothing about the position in trip, ops or storage', async () => {
    const routes = new FixtureRouteProvider([...MATRIX, legOf('_current_location', 2, 1200)]);
    const m = mini(items(), 90, { sources: fixtureSources(routes) });
    const { res, raw } = await m.replan({ location: { kind: 'coords', point: { lat: 12.3456, lng: 98.7654 } }, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(res.start).toEqual({ kind: 'coords', placeId: null });
    expect(res.startLeg?.durationSeconds).toBe(1200);
    expect(startMin(byId(c.trip, 'a2'))).toBe(110);
    assertNoLocationLeak(raw, c, ['12.3456', '98.7654']);
    expect(JSON.stringify(res.startLeg)).not.toContain('12.3456');
    expect(legsOf(c.trip).some(l => l.fromPlaceId === '_current_location' || l.toPlaceId === '_current_location')).toBe(false);
    await expectPatchMatches(m, res);
    const dump = JSON.stringify(m.stored()) + m.rows();
    expect(dump).not.toContain('_current_location');
    expect(dump).not.toContain('12.3456');
  });
});

describe('予約維持 (reservations kept)', () => {
  it('a fixed item among the remaining stops is byte-identical, no update/remove op, no fixed_activity_* issue', async () => {
    const f1 = act('f1', 4, 200, 250, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), act('a2', 2, 60, 110), f1], 90);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(JSON.stringify(byId(c.trip, 'f1'))).toBe(JSON.stringify(f1));
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
    expect(c.kept.fixed).toContain('f1');
    const v = validateSchedule({ days: c.trip.days, places: c.trip.places, constraints: c.trip.constraints, fixedActivities: [f1], dayStarts: c.trip.days.map(() => null) });
    expect(v.issues.map(i => i.code)).not.toContain('fixed_activity_changed');
    expect(v.issues.map(i => i.code)).not.toContain('fixed_activity_missing');
    await expectPatchMatches(m, res);
    expect(byId(m.stored(), 'f1')).toEqual(f1);
  });

  it('a gap too short to reach the reservation: it is kept and reported unreachable', async () => {
    const f1 = act('f1', 5, 120, 170, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), f1], 100); // P1 -> P5 takes 40 min, only 20 left
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'unreachable' });
    expect(c.warnings).toContain('予約「f1」に間に合わない可能性があります。予約先に確認してください。');
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
  });

  it('a flexible stop that no longer fits before the reservation is untimed; the reservation is kept and has a conflict', async () => {
    const f1 = act('f1', 5, 120, 170, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), act('a2', 2, 60, 110), f1], 100);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts.some(x => x.activityId === 'f1')).toBe(true);
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
  });

  it('a future fixed item without times is kept as is and reported time_unknown', async () => {
    const f1 = act('f1', 4, null, null, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), act('a2', 2, 60, 110), f1], 90);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(c.reservationConflicts).toContainEqual({ activityId: 'f1', reason: 'time_unknown' });
    expect(touchesFixed(c.operations, 'f1')).toBe(false);
  });

  it('an ongoing reservation stays and the remaining stops start after it', async () => {
    const f1 = act('f1', 2, 60, 110, { fixed: true });
    const m = mini([act('a1', 1, 0, 50), f1, act('a3', 3, 120, 170)], 80);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(res.start).toEqual({ kind: 'ongoing', placeId: 'P2' });
    expect(byId(c.trip, 'f1')).toEqual(f1);
    expect(startMin(byId(c.trip, 'a3'))).toBeGreaterThanOrEqual(120);
    expect(c.reservationConflicts.some(x => x.activityId === 'f1')).toBe(false);
  });

  it('fixedActivityIds pins an item for this run only: it stays at its time and the stored fixed flag is unchanged after PATCH', async () => {
    const pinned = act('a3', 3, 150, 200);
    const m = mini([act('a1', 1, 0, 50), act('a2', 2, 60, 110), pinned, act('a4', 4, 210, 260)], 55);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'], fixedActivityIds: ['a3'] });
    const c = res.candidates[0]!;
    expect(byId(c.trip, 'a3')).toEqual(pinned);
    expect(byId(c.trip, 'a3').fixed).toBe(false);
    expect(c.kept.fixed).toContain('a3');
    expect(startMin(byId(c.trip, 'a2'))).toBe(65);
    expect(touchesFixed(c.operations, 'a3')).toBe(false);
    const stored = await expectPatchMatches(m, res);
    expect(byId(stored, 'a3')).toEqual(pinned);
    expect(byId(m.stored(), 'a3').fixed).toBe(false);
  });
});

describe('更新競合 (update conflict)', () => {
  it('a stale expectedRevision is 409 REVISION_CONFLICT with details', async () => {
    const m = mini(items(), 90);
    const r = await m.post({ expectedRevision: 5, location: unavailable });
    expect(r.statusCode).toBe(409);
    expect(ApiError.parse(r.json())).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 5, currentRevision: 1 } });
  });

  it('after another PATCH the replan operations are refused with 409 and the stored trip is unchanged', async () => {
    const m = mini(items(), 90);
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    expect((await m.patch(1, [{ op: 'set_title', title: 'Other edit' }])).statusCode).toBe(200);
    const snapshot = JSON.stringify(m.stored()) + m.rows();
    const stale = await m.patch(res.baseRevision, res.candidates[0]!.operations);
    expect(stale.statusCode).toBe(409);
    expect(ApiError.parse(stale.json())).toMatchObject({ code: 'REVISION_CONFLICT', details: { expectedRevision: 1, currentRevision: 2 } });
    expect(JSON.stringify(m.stored()) + m.rows()).toBe(snapshot);
    expect(m.stored().revision).toBe(2);
    expect(byId(m.stored(), 'a1').status).toBe('planned');
  });
});

describe('Security and limits', () => {
  it('rejects bad bodies with 422 VALIDATION_FAILED (unknown key, leg id, skipped activity, bad maxCandidates, missing location)', async () => {
    const withLeg = [act('a1', 1, 0, 50), { ...legOf(1, 2, 600), legId: 'l12', departure: at(50), arrival: at(60) }, act('a2', 2, 60, 110), act('a3', 3, 120, 170, { status: 'skipped' })];
    const m = mini(withLeg, 90);
    const ok = { expectedRevision: 1, location: unavailable };
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, completedActivityIds: ['l12'] }, { ...ok, completedActivityIds: ['a3'] }, { ...ok, maxCandidates: 3 }, { ...ok, maxCandidates: 0 }, { expectedRevision: 1 }, { ...ok, location: { kind: 'coords', point: { lat: 1 } } }, { ...ok, fixedActivityIds: ['ghost'] }, { ...ok, missedActivityIds: ['ghost'] }, { ...ok, location: { kind: 'unavailable', reason: 'x' } }]) {
      const r = await m.post(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
    }
  });

  it('an operation that cannot apply is 422 CONSTRAINT_UNSATISFIED with operationIndex; an unsourced leg is RESTRICTED_ASSET', async () => {
    const m = mini(items(), 90);
    const bad = await m.post({ expectedRevision: 1, location: unavailable, operations: [{ op: 'set_title', title: 'ok' }, { op: 'remove', itemId: 'ghost' }] });
    expect(bad.statusCode).toBe(422);
    expect(ApiError.parse(bad.json())).toMatchObject({ code: 'CONSTRAINT_UNSATISFIED', details: { operationIndex: 1 } });
    const unsourced = { ...legOf(1, 3, 600), legId: 'x1', lineName: 'X', provenance: null, dataStatus: 'unknown' };
    const r = await m.post({ expectedRevision: 1, location: unavailable, operations: [{ op: 'add', dayIndex: 0, position: 1, item: unsourced }] });
    expect(r.statusCode).toBe(422);
    expect(ApiError.parse(r.json()).code).toBe('RESTRICTED_ASSET');
  });

  it('now outside the trip is 422 CONSTRAINT_UNSATISFIED outside_trip', async () => {
    const m = mini(items(), '2026-12-01T00:00:00Z');
    const r = await m.post({ expectedRevision: 1, location: unavailable });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ code: 'CONSTRAINT_UNSATISFIED', details: { reason: 'outside_trip' } });
  });

  it('a preview writes nothing and the revision is unchanged; responses are no-store', async () => {
    const m = mini(items(), 90);
    const before = JSON.stringify(m.stored()) + m.rows();
    for (const body of [{ location: unavailable, completedActivityIds: ['a1'] }, { location: unavailable, operations: [{ op: 'remove', itemId: 'a3' }] }, { location: { kind: 'coords', point: { lat: 1.5, lng: 2.5 } } }]) {
      const { headers } = await m.replan(body);
      expect(headers['cache-control']).toBe('no-store');
    }
    expect((await m.post({ expectedRevision: 9, location: unavailable })).headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(m.stored()) + m.rows()).toBe(before);
    expect(m.stored().revision).toBe(1);
  });

  it('one preview at a time per user: a concurrent request is 429 RATE_LIMITED, then it works again', async () => {
    let release!: () => void;
    const gate = new Promise<void>(res => (release = res));
    const routes: RouteProvider = { route: async () => (await gate, { leg: null, reason: 'no_route' as const }) };
    const m = mini(items(), 90, { sources: fixtureSources(routes) });
    const body = { expectedRevision: 1, location: unavailable, completedActivityIds: ['a1'] };
    const first = m.post(body);
    await new Promise(r => setTimeout(r, 20));
    const second = await m.post(body);
    expect(second.statusCode).toBe(429);
    expect(ApiError.parse(second.json()).code).toBe('RATE_LIMITED');
    release();
    expect((await first).statusCode).toBe(200);
    expect((await m.post(body)).statusCode).toBe(200);
  });

  it('live budget 0: no provider call, 200 with the limit notice and unknown legs, nothing stored', async () => {
    const urls: string[] = [];
    const fakeFetch = (async (u: string) => (urls.push(u), new Response(JSON.stringify({ routes: [{ duration: '600s', distanceMeters: 3000 }] }), { status: 200 }))) as unknown as typeof fetch;
    const sources = createContextSources({ providerMode: 'mixed' }, { GOOGLE_MAPS_SERVER_KEY: 'k' }, { fetch: fakeFetch, now: () => Date.UTC(2026, 9, 24) });
    const budget = createUserRouteBudget({ perDay: 0 });
    const m = mini(items(), 90, { sources, routeBudget: budget });
    const before = m.rows();
    const { res } = await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    const c = res.candidates[0]!;
    expect(urls).toHaveLength(0);
    expect(c.warnings.some(w => w.includes('上限'))).toBe(true);
    expect(c.unknown).toContain('legs');
    expect(m.rows()).toBe(before);
  });

  it('fixture mode makes no live call even with a throwing provider wrapper elsewhere (routes are the injected fake only)', async () => {
    let calls = 0;
    const routes: RouteProvider = { route: async () => (calls++, { leg: null, reason: 'no_route' as const }) };
    const m = mini(items(), 90, { sources: fixtureSources(routes) });
    await m.replan({ location: unavailable, completedActivityIds: ['a1'] });
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(6 + 6);
  });

  it('source scan: replan/ has no child_process, spawn or @tkb/ai', () => {
    const dir = join(import.meta.dirname, '../src/trips/replan');
    const files = readdirSync(dir).filter(f => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/child_process|spawn|exec(?:File|Sync)?\s*\(|@tkb\/ai/);
    }
  });
});

describe('A06 over the real shared app (auth, ownership)', () => {
  function real() {
    const db = openDatabase(':memory:');
    migrate(db);
    for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: '2026-10-24T03:00:00Z' });
    insertTrip(db, 'user_a', mkTrip(items()), '2026-10-01T00:00:00Z');
    const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
    closers.push(app);
    const login = async (loginId: string) => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
      return { cookie: String(r.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': r.json().csrfToken as string };
    };
    const send = (url: string, headers: Record<string, string>, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as object, headers });
    return { db, login, send };
  }
  const URL = '/api/v1/trips/t_a06/replan';
  const body = { expectedRevision: 1, location: unavailable };

  it('401 without a session; another user and a missing trip get the same 404', async () => {
    const { login, send } = real();
    expect((await send(URL, {}, body)).statusCode).toBe(401);
    const a = await login('user-a');
    const b = await login('user-b');
    expect((await send(URL, { cookie: a.cookie }, body)).statusCode).toBe(403);
    const other = await send(URL, b, body);
    const missing = await send('/api/v1/trips/nope/replan', b, body);
    for (const r of [other, missing]) {
      expect(r.statusCode).toBe(404);
      expect({ ...r.json(), requestId: 0 }).toEqual({ ...other.json(), requestId: 0 });
    }
    const own = await send(URL, a, body); // the wall clock is outside the trip dates: refused, not a 404
    expect(own.statusCode).toBe(422);
  });
});
