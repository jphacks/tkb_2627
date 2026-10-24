// Shared world builder for the T03 access matrix. HTTP only; direct DB writes are limited to
// preparing users and the source trip (there is no public API that creates a trip with secrets).
import { expect } from 'vitest';
import type { Trip } from '@tkb/contracts';
import { fixtureTrips } from '@tkb/fixtures';
import { createUser, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../../apps/server/src/platform/app.ts';
import { hashPassword } from '../../apps/server/src/platform/auth/password.ts';
import { loadConfig } from '../../apps/server/src/platform/config.ts';

export const PW = 'correct horse battery';
const NOW = '2026-10-24T03:00:00Z';
export type App = ReturnType<typeof buildApp>;
export type Db = ReturnType<typeof openDatabase>;
export interface Session { cookie: string; csrf: string }
export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
export const ACTORS = ['anon', 'owner', 'member', 'other', 'removed'] as const;
export type Actor = (typeof ACTORS)[number];
export type Actors = Record<Actor, Session | null>;
export const VIS = ['private', 'group', 'public'] as const;
export type Vis = (typeof VIS)[number];

let pwHash: string | null = null;
export const apps: App[] = [];
export async function closeAll() {
  while (apps.length) await apps.pop()!.close();
}

export const call = (app: App, s: Session | null, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: s ? { cookie: s.cookie, 'x-csrf-token': s.csrf } : {} });
/** Valid session cookie, CSRF header omitted. */
export const callNoCsrf = (app: App, s: Session, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie } });
export const stripReq = (res: { json: () => Record<string, unknown> }) => ({ ...res.json(), requestId: '' });

export async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}

/** Trip carrying private data in every field the snapshot must strip. */
export function secretTrip(id: string, marker: string): Trip {
  const t = structuredClone(fixtureTrips[0]!);
  t.tripId = id;
  t.title = `TITLE-${marker}`;
  t.constraints.budget = { amountMinor: 987654, currency: 'JPY' };
  t.constraints.departure = { placeId: 'home_x', label: `HOME-${marker}`, time: null };
  t.constraints.return = { placeId: 'home_x', label: `HOME-${marker}`, time: null };
  t.places.push({ ...t.places[0]!, placeId: 'home_x', name: `HOMENAME-${marker}`, location: { lat: 35.68, lng: 139.75 } });
  for (const d of t.days) for (const it of d.items) if (it.type === 'activity') it.privateNotes = `NOTE-${marker}`;
  return t;
}
export const LEAKS = (marker: string) => [`NOTE-${marker}`, `HOME-${marker}`, `HOMENAME-${marker}`, '987654'];

export async function makeWorld() {
  pwHash ??= await hashPassword(PW);
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b', 'user_c', 'user_d']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: NOW });
  }
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  apps.push(app);
  const a = await login(app, 'user-a');
  const b = await login(app, 'user-b');
  const c = await login(app, 'user-c');
  const d = await login(app, 'user-d');
  const actors: Actors = { anon: null, owner: a, member: b, other: c, removed: d };

  const gid = (await call(app, a, 'POST', '/api/v1/groups', { name: 'club' })).json().groupId as string;
  const join = async (s: Session, userId: string) => {
    const inv = await call(app, a, 'POST', `/api/v1/groups/${gid}/invites`, { inviteeId: userId });
    expect(inv.statusCode).toBe(201);
    const acc = await call(app, s, 'POST', '/api/v1/group-invites/accept', { token: (inv.json().inviteUrl as string).split('#')[1] });
    expect(acc.statusCode).toBe(200);
  };
  await join(b, 'user_b');
  await join(d, 'user_d');
  // D is removed by the owner over HTTP; from here D must behave like a stranger.
  expect((await call(app, a, 'DELETE', `/api/v1/groups/${gid}/members/user_d`)).statusCode).toBe(204);

  const tripA = insertTrip(db, 'user_a', secretTrip('trip_acc_a', 'A'), NOW);
  const tripC = insertTrip(db, 'user_c', secretTrip('trip_acc_c', 'C'), NOW);

  const publish = async (s: Session, tripId: string, vis: Vis, story: string) => {
    const pv = await call(app, s, 'POST', '/api/v1/posts/preview', { tripId, sourceRevision: 1, visibility: vis, groupId: vis === 'group' ? gid : null, story });
    expect(pv.statusCode).toBe(200);
    const res = await call(app, s, 'POST', '/api/v1/posts', { previewToken: pv.json().previewToken, confirmed: true });
    expect(res.statusCode).toBe(201);
    return res.json() as { postId: string; postRevision: number };
  };
  const posts = {} as Record<Vis, { postId: string; postRevision: number; story: string }>;
  for (const v of VIS) {
    const story = `STORY-${v}`;
    posts[v] = { ...(await publish(a, tripA.tripId, v, story)), story };
  }
  return { app, db, actors, gid, tripA, tripC, posts, publish };
}
export type World = Awaited<ReturnType<typeof makeWorld>>;

/** Who may read a post (model/visibility.json). */
export const canRead = (v: Vis, who: Actor): boolean =>
  v === 'public' ? true : v === 'group' ? who === 'owner' || who === 'member' : who === 'owner';
