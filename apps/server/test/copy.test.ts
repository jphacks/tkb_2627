import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Trip } from '@tkb/contracts';
import { fixtureTrips } from '@tkb/fixtures';
import { createUser, getTripForOwner, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';

const PW = 'correct horse battery';
const NOW = '2026-10-24T03:00:00Z';
const apps: ReturnType<typeof buildApp>[] = [];
let pwHash: string;
beforeAll(async () => {
  pwHash = await hashPassword(PW);
});
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

type App = ReturnType<typeof buildApp>;
interface Session { cookie: string; csrf: string }

function make() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b', 'user_c']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: NOW });
  }
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  apps.push(app);
  return { app, db };
}
async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const call = (app: App, s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });

let seq = 0;
/** A trip with private data everywhere the snapshot must not carry it. */
function secretTrip(): Trip {
  const t = structuredClone(fixtureTrips[0]!);
  t.tripId = `trip_s06_${++seq}`;
  t.constraints.budget = { amountMinor: 99999, currency: 'JPY' };
  t.constraints.departure = { placeId: 'home_tanaka', label: '東京都千代田区1-1-1 自宅', time: null };
  t.constraints.return = { placeId: 'home_tanaka', label: '東京都千代田区1-1-1 自宅', time: null };
  t.places.push({ ...t.places[0]!, placeId: 'home_tanaka', name: '田中邸', location: { lat: 35.68, lng: 139.75 } });
  const day0 = t.days[0]!.items;
  day0.unshift({ ...(day0[0] as Extract<(typeof day0)[number], { type: 'leg' }>), legId: 'leg_home', fromPlaceId: 'home_tanaka', toPlaceId: 'fx_kanazawa_station' });
  day0.push({ ...(day0.find((i) => i.type === 'activity') as Extract<(typeof day0)[number], { type: 'activity' }>), activityId: 'act_home', placeId: 'home_tanaka', title: 'Home stop' });
  const restricted = day0.find((i) => i.type === 'leg' && i.legId === 'fx_leg_2');
  if (restricted && restricted.type === 'leg' && restricted.provenance) restricted.provenance = { ...restricted.provenance, mayExport: false };
  const kenroku = t.places.find((p) => p.placeId === 'fx_kenrokuen')!;
  kenroku.photo = { url: 'https://example.com/nolicense.jpg', attribution: 'x', license: null };
  t.constraints.preferences = ['secret preference'];
  for (const d of t.days) for (const it of d.items) if (it.type === 'activity') it.privateNotes = 'PRIVATE-NOTE';
  const omicho = t.places.find((p) => p.placeId === 'fx_omicho')!;
  omicho.provenance = { ...omicho.provenance, mayExport: false };
  omicho.photo = { url: 'https://example.com/p.jpg', attribution: 'x', license: null };
  t.places.push({ ...t.places[0]!, placeId: 'fx_unreferenced', name: 'UNREFERENCED' });
  return t;
}

async function setup() {
  const { app, db } = make();
  const a = await login(app, 'user-a');
  const b = await login(app, 'user-b');
  const c = await login(app, 'user-c');
  const gid = (await call(app, a, 'POST', '/api/v1/groups', { name: 'club' })).json().groupId as string;
  const inv = (await call(app, a, 'POST', `/api/v1/groups/${gid}/invites`, { inviteeId: 'user_b' })).json().inviteUrl as string;
  expect((await call(app, b, 'POST', '/api/v1/group-invites/accept', { token: inv.split('#')[1] })).statusCode).toBe(200);
  const trip = insertTrip(db, 'user_a', secretTrip(), NOW);
  const publish = async (s: Session, tripId: string, rev: number, visibility: string, groupId: string | null = null, story = 'story') => {
    const pv = await call(app, s, 'POST', '/api/v1/posts/preview', { tripId, sourceRevision: rev, visibility, groupId, story });
    expect(pv.statusCode).toBe(200);
    const res = await call(app, s, 'POST', '/api/v1/posts', { previewToken: pv.json().previewToken, confirmed: true });
    expect(res.statusCode).toBe(201);
    return res.json();
  };
  return { app, db, a, b, c, gid, trip, publish };
}


const tripDump = (db: ReturnType<typeof openDatabase>, id: string) => JSON.stringify([
  db.prepare('SELECT * FROM trips WHERE id = ?').all(id),
  db.prepare('SELECT * FROM trip_versions WHERE trip_id = ?').all(id),
]);
const REQ = { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo' };
const copy = (app: App, s: Session | null, postId: string, payload: unknown = REQ) =>
  call(app, s, 'POST', `/api/v1/posts/${postId}/copy`, payload);

describe('copy post to own trip (S06)', () => {
  it('B copies a public post: owner B, draft, new dates, no times, no private data; source untouched', async () => {
    const { app, db, a, b, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'public');
    const postBefore = JSON.stringify(db.prepare('SELECT * FROM posts').all()) + JSON.stringify(db.prepare('SELECT * FROM post_snapshots').all());
    const tripBefore = tripDump(db, trip.tripId);
    const res = await copy(app, b, post.postId, { ...REQ, timeZone: 'Asia/Tokyo' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const r = res.json();
    expect(r).toMatchObject({ ownerId: 'user_b', revision: 1, validationState: 'needs_revalidation' });
    const t = getTripForOwner(db, r.tripId, 'user_b')!;
    expect(t).not.toBeNull();
    expect(getTripForOwner(db, r.tripId, 'user_a')).toBeNull();
    expect(t.tripId).not.toBe(trip.tripId);
    expect(t.constraints.startDate).toBe('2027-03-10');
    expect(t.days.map((d) => d.date)).toEqual(post.snapshot.days.map((_: unknown, i: number) => `2027-03-${10 + i}`));
    expect(t.constraints.endDate).toBe(t.days.at(-1)!.date);
    expect(t.days.every((d) => d.timeZone === 'Asia/Tokyo')).toBe(true);
    expect(t.constraints).not.toHaveProperty('budget');
    expect(t.constraints).not.toHaveProperty('departure');
    expect(t.constraints).not.toHaveProperty('return');
    expect(t.warnings.length).toBeGreaterThan(0);
    for (const it of t.days.flatMap((d) => d.items)) {
      if (it.type === 'activity') {
        expect(it).toMatchObject({ start: null, end: null, privateNotes: null, status: 'planned' });
      } else {
        expect(it).toMatchObject({ departure: null, arrival: null, durationSeconds: null, fare: null, platform: null, lineName: null, transfers: null, provenance: null, dataStatus: 'unknown' });
      }
    }
    const text = JSON.stringify(t);
    for (const bad of ['PRIVATE-NOTE', '千代田', '99999', 'secret preference', 'home_tanaka', '田中邸', 'UNREFERENCED']) expect(text).not.toContain(bad);
    expect(t.title).toBe(`${post.snapshot.title}（コピー）`);
    // Source post, snapshot, trip and versions are byte-identical.
    expect(JSON.stringify(db.prepare('SELECT * FROM posts').all()) + JSON.stringify(db.prepare('SELECT * FROM post_snapshots').all())).toBe(postBefore);
    expect(tripDump(db, trip.tripId)).toBe(tripBefore);
    // Repeated copies are allowed and independent; custom title is honoured.
    const again = await copy(app, b, post.postId, { ...REQ, title: 'My plan' });
    expect(again.statusCode).toBe(201);
    expect(again.json().tripId).not.toBe(r.tripId);
    expect(getTripForOwner(db, again.json().tripId, 'user_b')!.title).toBe('My plan');
  });

  it('replaces the time zone and drops legs with hidden or unknown endpoints', async () => {
    const { app, db, a, b, publish } = await setup();
    const t0 = secretTrip();
    t0.tripId = 'trip_s06_hidden';
    const day0 = t0.days[0]!.items;
    const leg = day0.find((i) => i.type === 'leg') as Extract<(typeof day0)[number], { type: 'leg' }>;
    day0.push({ ...leg, legId: 'leg_to_hidden', fromPlaceId: 'fx_kenrokuen', toPlaceId: 'fx_omicho' });
    const src = insertTrip(db, 'user_a', t0, NOW);
    const post = await publish(a, src.tripId, 1, 'public');
    type L = { fromPlaceId: string; toPlaceId: string; legId: string };
    const legsOf = (days: { items: { type: string }[] }[]) => days.flatMap((d) => d.items).filter((i) => i.type === 'leg') as unknown as L[];
    const snapLegs = legsOf(post.snapshot.days);
    expect(snapLegs.some((l) => l.toPlaceId.startsWith('hidden_'))).toBe(true);
    const res = await copy(app, b, post.postId, { newStartDate: '2027-12-30', timeZone: 'Europe/Paris' });
    expect(res.statusCode).toBe(201);
    const t = getTripForOwner(db, res.json().tripId, 'user_b')!;
    expect(t.constraints.timeZone).toBe('Europe/Paris');
    expect(t.days.map((d) => d.date).slice(0, 2)).toEqual(['2027-12-30', '2027-12-31']);
    const ids = new Set(t.places.map((p) => p.placeId));
    const kept = legsOf(t.days);
    expect(kept.some((l) => l.legId === 'leg_to_hidden')).toBe(false);
    expect(kept.length).toBeLessThan(snapLegs.length);
    for (const l of kept) expect(ids.has(l.fromPlaceId) && ids.has(l.toPlaceId)).toBe(true);
    expect(JSON.stringify(t)).not.toContain('hidden_');
  });

  it('visibility: group member ok, outsider/removed/private/deleted 404, anonymous 401', async () => {
    const { app, db, a, b, c, gid, trip, publish } = await setup();
    const gp = await publish(a, trip.tripId, 1, 'group', gid);
    expect((await copy(app, b, gp.postId)).statusCode).toBe(201);
    expect((await copy(app, c, gp.postId)).statusCode).toBe(404);
    expect((await copy(app, null, gp.postId)).statusCode).toBe(401);
    const before = (db.prepare('SELECT COUNT(*) n FROM trips').get() as { n: number }).n;
    // Removing B's membership takes effect immediately.
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, 'user_b');
    expect((await copy(app, b, gp.postId)).statusCode).toBe(404);
    expect((db.prepare('SELECT COUNT(*) n FROM trips').get() as { n: number }).n).toBe(before);
    const priv = await publish(a, trip.tripId, 1, 'private');
    expect((await copy(app, b, priv.postId)).statusCode).toBe(404);
    expect((await copy(app, a, priv.postId)).statusCode).toBe(201);
    const pub = await publish(a, trip.tripId, 1, 'public');
    expect((await call(app, a, 'DELETE', `/api/v1/posts/${pub.postId}`)).statusCode).toBe(204);
    expect((await copy(app, b, pub.postId)).statusCode).toBe(404);
    expect((await copy(app, b, 'no_such_post')).statusCode).toBe(404);
  });

  it('rejects invalid dates, time zones and extra fields with 422, and requires CSRF', async () => {
    const { app, b, a, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'public');
    for (const bad of [
      {},
      { newStartDate: '2027-02-30', timeZone: 'Asia/Tokyo' },
      { newStartDate: 'tomorrow', timeZone: 'Asia/Tokyo' },
      { newStartDate: '2027-03-10', timeZone: 'Mars/Base' },
      { newStartDate: '2027-03-10', timeZone: 'Asia/Tokyo', ownerId: 'user_a' },
      { ...REQ, title: '' },
    ]) {
      expect((await copy(app, b, post.postId, bad)).statusCode).toBe(422);
    }
    const noCsrf = await app.inject({ method: 'POST', url: `/api/v1/posts/${post.postId}/copy`, payload: REQ, headers: { cookie: b.cookie } });
    expect(noCsrf.statusCode).toBe(403);
  });

  it('resets cost/fixed, issues new ids, handles leap years, and rejects overflow/blank title', async () => {
    const { app, db, a, b, c, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'public');
    const srcActs = post.snapshot.days.flatMap((d: { items: { type: string }[] }) => d.items).filter((i: { type: string }) => i.type === 'activity');
    expect(srcActs.some((i: { cost: unknown }) => i.cost !== null)).toBe(true);
    const res = await copy(app, b, post.postId, { newStartDate: '2028-02-28', timeZone: 'Asia/Tokyo' });
    expect(res.statusCode).toBe(201);
    const t = getTripForOwner(db, res.json().tripId, 'user_b')!;
    const expected = ['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02'].slice(0, t.days.length);
    expect(t.days.map((d) => d.date)).toEqual(expected);
    const items = t.days.flatMap((d) => d.items);
    for (const it of items) if (it.type === 'activity') expect(it).toMatchObject({ cost: null, costStatus: 'unknown', fixed: false });
    const srcIds = new Set(post.snapshot.days.flatMap((d: { items: Record<string, string>[] }) => d.items.map((i) => i.activityId ?? i.legId)));
    const newIds = items.map((i) => (i.type === 'activity' ? i.activityId : i.legId));
    expect(newIds.length).toBeGreaterThan(0);
    expect(new Set(newIds).size).toBe(newIds.length);
    for (const id of newIds) expect(srcIds.has(id)).toBe(false);
    expect((await copy(app, b, post.postId, { newStartDate: '9999-12-31', timeZone: 'Asia/Tokyo' })).statusCode).toBe(post.snapshot.days.length > 1 ? 422 : 201);
    expect((await copy(app, b, post.postId, { newStartDate: '9999-12-30', timeZone: 'Asia/Tokyo' })).statusCode).toBe(post.snapshot.days.length > 2 ? 422 : 201);
    expect((await copy(app, b, post.postId, { ...REQ, title: '   ' })).statusCode).toBe(422);
    // No access: 404 comes before body validation.
    const priv = await publish(a, trip.tripId, 1, 'private');
    expect((await copy(app, c, priv.postId, { newStartDate: 'bad' })).statusCode).toBe(404);
    expect((await copy(app, b, priv.postId, {})).statusCode).toBe(404);
  });

  it('keeps the copy suffix on a very long source title', async () => {
    const { app, db, a, b, publish } = await setup();
    const t0 = secretTrip();
    t0.tripId = 'trip_s06_long';
    t0.title = '旅'.repeat(200);
    const src = insertTrip(db, 'user_a', t0, NOW);
    const post = await publish(a, src.tripId, 1, 'public');
    const res = await copy(app, b, post.postId);
    expect(res.statusCode).toBe(201);
    const t = getTripForOwner(db, res.json().tripId, 'user_b')!;
    expect(Array.from(t.title).length).toBe(200);
    expect(t.title.endsWith('（コピー）')).toBe(true);
  });

  it('limits copies to 10 per user per minute', async () => {
    const { app, b, a, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'public');
    for (let i = 0; i < 10; i++) expect((await copy(app, b, post.postId)).statusCode).toBe(201);
    expect((await copy(app, b, post.postId)).statusCode).toBe(429);
    expect((await copy(app, a, post.postId)).statusCode).toBe(201);
  });
});
