import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Trip } from '@tkb/contracts';
import { fixtureTrips } from '@tkb/fixtures';
import { createUser, insertTrip, migrate, openDatabase, updateTripWithRevision } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { registerAuth } from '../src/platform/auth/index.ts';
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
  t.tripId = `trip_s05_${++seq}`;
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

describe('SNS posts (S05)', () => {
  it('group post: A/B read it, C/anonymous get 404, snapshot is redacted', async () => {
    const { app, a, b, c, gid, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'group', gid);
    const url = `/api/v1/posts/${post.postId}`;
    for (const s of [a, b]) {
      const r = await call(app, s, 'GET', url);
      expect(r.statusCode).toBe(200);
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect((await call(app, c, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, null, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, c, 'GET', '/api/v1/posts?scope=groups')).json().items).toEqual([]);
    expect((await call(app, b, 'GET', '/api/v1/posts?scope=groups')).json().items).toHaveLength(1);
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=public')).json().items).toEqual([]);
    const text = JSON.stringify(post.snapshot);
    for (const bad of ['PRIVATE-NOTE', '千代田', 'budget', '99999', 'secret preference', 'privateNotes', 'UNREFERENCED', 'example.com/p.jpg', 'home_tanaka', '田中邸', 'leg_home', 'fx_omicho', 'nolicense']) {
      expect(text).not.toContain(bad);
    }
    expect(post.snapshot.constraints).not.toHaveProperty('departure');
    expect(post.snapshot.constraints).not.toHaveProperty('budget');
    // The home place, its legs and the mayExport=false place are withheld; the activity at home is dropped entirely.
    const items: Record<string, unknown>[] = post.snapshot.days.flatMap((d: { items: Record<string, unknown>[] }) => d.items);
    expect(items.find((i) => i.activityId === 'act_home')).toBeUndefined();
    expect(text).not.toContain('Home stop');
    expect(items.find((i) => i.legId === 'fx_leg_2')).toMatchObject({ dataStatus: 'unavailable', fare: null, provenance: null });
    expect(post.snapshot.places.length).toBeGreaterThan(0);
    expect(post.snapshot.places.find((p: { placeId: string }) => p.placeId === 'fx_kenrokuen').photo).toBeNull();
  });

  it('preview lists redacted fields and rejects non-owner, missing trip, stale revision, non-member group', async () => {
    const { app, a, b, c, gid, trip } = await setup();
    const req = { tripId: trip.tripId, sourceRevision: 1, visibility: 'private', story: 's' };
    const ok = await call(app, a, 'POST', '/api/v1/posts/preview', req);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().redactedFields).toEqual(expect.arrayContaining(['homeAddress', 'privateNotes', 'budget', 'departure', 'placeProviderData', 'homeLegs']));
    expect((await call(app, b, 'POST', '/api/v1/posts/preview', req)).statusCode).toBe(404);
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', { ...req, tripId: 'nope' })).statusCode).toBe(404);
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', { ...req, sourceRevision: 2 })).statusCode).toBe(409);
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', { ...req, visibility: 'group', groupId: 'nope' })).statusCode).toBe(422);
    // missing group and a group the user is not in are indistinguishable
    const foreign = (await call(app, c, 'POST', '/api/v1/groups', { name: 'others' })).json().groupId as string;
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', { ...req, visibility: 'group', groupId: foreign })).statusCode).toBe(422);
    expect((await call(app, c, 'POST', '/api/v1/posts/preview', { ...req, visibility: 'group', groupId: gid })).statusCode).toBe(404); // not their trip
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', { ...req, visibility: 'group' })).statusCode).toBe(422);
    expect((await call(app, null, 'POST', '/api/v1/posts/preview', req)).statusCode).toBe(401);
  });

  it('removed member loses access via URL and feed; private change hides from members', async () => {
    const { app, a, b, gid, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'group', gid);
    const url = `/api/v1/posts/${post.postId}`;
    expect((await call(app, b, 'GET', url)).statusCode).toBe(200);
    expect((await call(app, a, 'DELETE', `/api/v1/groups/${gid}/members/user_b`)).statusCode).toBe(204);
    expect((await call(app, b, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, b, 'GET', '/api/v1/posts?scope=groups')).json().items).toEqual([]);
  });

  it('PATCH to private/public, optimistic lock, owner-only, group re-check; DELETE', async () => {
    const { app, a, b, c, gid, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'group', gid);
    const url = `/api/v1/posts/${post.postId}`;
    expect((await call(app, b, 'PATCH', url, { expectedPostRevision: 1, story: 'x' })).statusCode).toBe(404);
    expect((await call(app, b, 'DELETE', url)).statusCode).toBe(404);
    const priv = await call(app, a, 'PATCH', url, { expectedPostRevision: 1, visibility: 'private' });
    expect(priv.statusCode).toBe(200);
    expect(priv.json().postRevision).toBe(2);
    expect((await call(app, b, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, a, 'GET', url)).statusCode).toBe(200);
    expect((await call(app, a, 'PATCH', url, { expectedPostRevision: 1, story: 'stale' })).statusCode).toBe(409);
    // group change needs membership of a group the owner is still in
    expect((await call(app, a, 'PATCH', url, { expectedPostRevision: 2, visibility: 'group', groupId: 'nope' })).statusCode).toBe(422);
    const pub = await call(app, a, 'PATCH', url, { expectedPostRevision: 2, visibility: 'public', story: 'open' });
    expect(pub.json()).toMatchObject({ visibility: 'public', story: 'open', postRevision: 3 });
    expect((await call(app, null, 'GET', url)).statusCode).toBe(200);
    expect((await call(app, c, 'GET', '/api/v1/posts?scope=public')).json().items).toHaveLength(1);
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=public')).json().items[0].authorDisplayName).toBe('user_a');
    expect((await call(app, a, 'DELETE', url)).statusCode).toBe(204);
    expect((await call(app, a, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, null, 'GET', url)).statusCode).toBe(404);
    expect((await call(app, a, 'DELETE', url)).statusCode).toBe(404);
    expect((await call(app, a, 'GET', '/api/v1/posts?scope=mine')).json().items).toEqual([]);
  });

  it('anonymous may only read public; groups/mine need login', async () => {
    const { app } = await setup();
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=groups')).statusCode).toBe(401);
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=mine')).statusCode).toBe(401);
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=public&limit=99')).statusCode).toBe(422);
    expect((await call(app, null, 'GET', '/api/v1/posts?scope=public&cursor=%%')).statusCode).toBe(422);
    expect((await call(app, null, 'POST', '/api/v1/posts', {})).statusCode).toBe(401);
    expect((await call(app, null, 'PATCH', '/api/v1/posts/x', {})).statusCode).toBe(401);
    expect((await call(app, null, 'DELETE', '/api/v1/posts/x')).statusCode).toBe(401);
  });

  it('commit rechecks: stale trip 409, expired 410, reuse 409, foreign token 404, membership lost 404', async () => {
    const { app, db, a, b, c, gid, trip } = await setup();
    const preview = async (s: Session, rev = 1, vis = 'private', g: string | null = null) =>
      (await call(app, s, 'POST', '/api/v1/posts/preview', { tripId: trip.tripId, sourceRevision: rev, visibility: vis, groupId: g, story: 's' })).json().previewToken as string;
    const commit = (s: Session, previewToken: string) => call(app, s, 'POST', '/api/v1/posts', { previewToken, confirmed: true });

    const t1 = await preview(a);
    expect(updateTripWithRevision(db, 'user_a', { ...trip, title: 'edited' }, 1, NOW).ok).toBe(true);
    expect((await commit(a, t1)).statusCode).toBe(409);

    const t2 = await preview(a, 2);
    expect((await commit(b, t2)).statusCode).toBe(404);
    expect((await commit(a, 'x'.repeat(43))).statusCode).toBe(404);
    expect((await commit(a, t2)).statusCode).toBe(201);
    expect((await commit(a, t2)).statusCode).toBe(409);
    expect(db.prepare("SELECT COUNT(*) n FROM posts").get()).toEqual({ n: 1 });
    expect(JSON.stringify(db.prepare('SELECT * FROM post_previews').all())).not.toContain(t2);

    const t3 = await preview(a, 2);
    db.prepare("UPDATE post_previews SET expires_at = '2000-01-01T00:00:00Z' WHERE consumed_at IS NULL").run();
    expect((await commit(a, t3)).statusCode).toBe(410);

    // membership lost between preview and commit
    await call(app, a, 'POST', `/api/v1/groups/${gid}/invites`, { inviteeId: 'user_c' });
    const t4 = await preview(a, 2, 'group', gid);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, 'user_a');
    expect((await commit(a, t4)).statusCode).toBe(404);
    expect((await call(app, c, 'GET', '/api/v1/posts?scope=mine')).json().items).toEqual([]);
  });

  it('snapshot stays unchanged after the source trip is edited', async () => {
    const { app, db, a, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'private');
    updateTripWithRevision(db, 'user_a', { ...trip, title: 'CHANGED LATER' }, 1, NOW);
    const r = await call(app, a, 'GET', `/api/v1/posts/${post.postId}`);
    expect(r.json().title).toBe(trip.title);
    expect(r.json().snapshot).toEqual(post.snapshot);
  });

  it('cursor paging with limit=1 never leaks posts outside the viewer ACL', async () => {
    const { app, db, a, b, c, gid, publish } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = insertTrip(db, 'user_a', secretTrip(), NOW);
      ids.push((await publish(a, t.tripId, 1, 'group', gid)).postId);
    }
    for (const vis of ['private', 'public']) {
      const t = insertTrip(db, 'user_a', secretTrip(), NOW);
      await publish(a, t.tripId, 1, vis);
    }
    const walk = async (s: Session | null, scope: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const res = await call(app, s, 'GET', `/api/v1/posts?scope=${scope}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode).toBe(200);
        const j = res.json();
        seen.push(...j.items.map((x: { postId: string }) => x.postId));
        cursor = j.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    expect((await walk(b, 'groups')).sort()).toEqual([...ids].sort());
    expect(await walk(c, 'groups')).toEqual([]);
    expect(await walk(null, 'public')).toHaveLength(1);
    expect(await walk(a, 'mine')).toHaveLength(5);
    expect(await walk(b, 'mine')).toEqual([]);
  });

  it('story-only PATCH does not re-check membership; switching to group does', async () => {
    const { app, db, a, gid, trip, publish } = await setup();
    const post = await publish(a, trip.tripId, 1, 'group', gid);
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(gid, 'user_a');
    const url = `/api/v1/posts/${post.postId}`;
    expect((await call(app, a, 'PATCH', url, { expectedPostRevision: 1, story: 'edited' })).statusCode).toBe(200);
    expect((await call(app, a, 'PATCH', url, { expectedPostRevision: 2, visibility: 'group', groupId: gid })).statusCode).toBe(422);
  });

  it('limits live previews per user to 30', async () => {
    const { app, a, trip } = await setup();
    const req = { tripId: trip.tripId, sourceRevision: 1, visibility: 'private', story: 's' };
    for (let i = 0; i < 30; i++) expect((await call(app, a, 'POST', '/api/v1/posts/preview', req)).statusCode).toBe(200);
    expect((await call(app, a, 'POST', '/api/v1/posts/preview', req)).statusCode).toBe(429);
  });

  it('one damaged snapshot does not break the feed', async () => {
    const { app, db, a, b, gid, publish } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const t = insertTrip(db, 'user_a', secretTrip(), NOW);
      ids.push((await publish(a, t.tripId, 1, 'group', gid)).postId);
    }
    db.prepare('UPDATE post_snapshots SET document_json = ? WHERE id = (SELECT snapshot_id FROM posts WHERE id = ?)').run('garbage', ids[0]!);
    const res = await call(app, b, 'GET', '/api/v1/posts?scope=groups');
    expect(res.statusCode).toBe(200);
    expect(res.json().items.map((i: { postId: string }) => i.postId)).toEqual([ids[1]]);
  });

  it('optionalAuthenticate is limited to the posts GET allow-list', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const app = Fastify();
    apps.push(app as unknown as ReturnType<typeof buildApp>);
    registerAuth(app, db, { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' });
    expect(() => app.get('/api/v1/other', { preHandler: app.optionalAuthenticate }, async () => ({}))).toThrow(/optionalAuthenticate/);
    expect(() => app.post('/api/v1/posts', { preHandler: app.optionalAuthenticate }, async () => ({}))).toThrow(/optionalAuthenticate/);
    expect(() => app.get('/api/v1/posts/:id', { preHandler: app.optionalAuthenticate }, async () => ({}))).not.toThrow();
  });
});
