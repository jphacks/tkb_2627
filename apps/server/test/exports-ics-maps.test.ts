import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, type Trip } from '@tkb/contracts';
import { createUser, insertTrip, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';
import { MapsLinksResponse } from '../src/platform/exports/calendar-maps.ts';
import { exportTrip } from './exports-fixture.ts';

const PW = 'correct horse battery';
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
const cfg = () => ({ ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' });

function make(owned: Trip = exportTrip()) {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b']) {
    createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: new Date().toISOString() });
  }
  insertTrip(db, 'user_a', owned, '2026-10-01T00:00:00Z');
  const app = buildApp({ config: cfg(), db });
  apps.push(app);
  return app;
}
async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  expect(res.statusCode).toBe(200);
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const get = (app: App, s: Session, url: string) => app.inject({ method: 'GET', url, headers: { cookie: s.cookie } });

/** The sample trip plus a child activity (inside act_ok) at its own, exportable place. */
function withChild(): Trip {
  const t = exportTrip();
  const base = t.places[1]!;
  t.places.push({ ...base, placeId: 'p_child', name: '茶屋', location: { lat: 35.123456, lng: 139.654321 }, photo: null });
  t.days[0]!.items.push({
    type: 'activity', activityId: 'act_child', parentActivityId: 'act_ok', kind: 'visit', title: '茶屋で一服', placeId: 'p_child', areaName: null,
    start: { utc: '2026-11-01T01:30:00Z', timeZone: 'Asia/Tokyo' }, end: { utc: '2026-11-01T02:00:00Z', timeZone: 'Asia/Tokyo' },
    fixed: false, status: 'planned', cost: null, costStatus: 'unknown', privateNotes: null,
  } as Trip['days'][number]['items'][number]);
  return t;
}
/** Only an activity at a restricted place, with no times: nothing can be exported. */
function nothing(): Trip {
  const t = exportTrip();
  t.days[0]!.items = t.days[0]!.items.filter(i => i.type === 'activity' && i.activityId === 'act_secret');
  return t;
}

describe('GET /api/v1/trips/:id/ics', () => {
  it('serves the owner an ICS attachment, no-store, without the home name or private notes', async () => {
    const app = make();
    const res = await get(app, await login(app, 'user-a'), '/api/v1/trips/trip_pdf/ics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toBe('attachment; filename="trip-trip_pdf.ics"');
    expect(res.body).toContain('BEGIN:VCALENDAR');
    expect(res.body).toContain('BEGIN:VEVENT');
    expect(res.body).toContain('TZID=Asia/Tokyo');
    expect(res.body).not.toContain('自宅マンション');
    expect(res.body).not.toContain('秘密のメモ');
    expect(res.body).not.toContain('非公開レストラン');
  });

  it('is 404 for another user and for a missing trip, 401 when anonymous', async () => {
    const app = make();
    const b = await login(app, 'user-b');
    const other = await get(app, b, '/api/v1/trips/trip_pdf/ics');
    expect(other.statusCode).toBe(404);
    expect(other.headers['cache-control']).toBe('no-store');
    expect((await get(app, b, '/api/v1/trips/nope/ics')).statusCode).toBe(404);
    const anon = await app.inject({ method: 'GET', url: '/api/v1/trips/trip_pdf/ics' });
    expect(anon.statusCode).toBe(401);
    expect(anon.headers['cache-control']).toBe('no-store');
  });

  it('is 422 RESTRICTED_ASSET when nothing can be exported', async () => {
    const app = make(nothing());
    const res = await get(app, await login(app, 'user-a'), '/api/v1/trips/trip_pdf/ics');
    expect(res.statusCode).toBe(422);
    expect(ApiError.parse(res.json()).code).toBe('RESTRICTED_ASSET');
  });
});

describe('GET /api/v1/trips/:id/maps-links', () => {
  it('lists links built only from allowed places, and the withheld ones', async () => {
    const app = make();
    const res = await get(app, await login(app, 'user-a'), '/api/v1/trips/trip_pdf/maps-links');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = MapsLinksResponse.parse(res.json());
    expect(body.links.length).toBeGreaterThan(0);
    for (const l of body.links) {
      expect(l.url.startsWith('https://www.google.com/maps/')).toBe(true);
      expect(decodeURIComponent(l.url)).not.toMatch(/非公開レストラン|自宅/);
    }
    expect(body.withheld).toContainEqual({ kind: 'place', id: 'p_no' });
    expect(JSON.stringify(body)).not.toContain('自宅マンション');
  });

  it('does not use child activities as waypoints', async () => {
    const app = make(withChild());
    const res = await get(app, await login(app, 'user-a'), '/api/v1/trips/trip_pdf/maps-links');
    expect(res.statusCode).toBe(200);
    const text = JSON.stringify(res.json());
    expect(text).not.toContain('35.123456');
    expect(text).not.toContain(encodeURIComponent('茶屋'));
  });

  it('is 404 for another user, 401 anonymous, 422 when nothing is exportable', async () => {
    const app = make();
    expect((await get(app, await login(app, 'user-b'), '/api/v1/trips/trip_pdf/maps-links')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/trips/trip_pdf/maps-links' })).statusCode).toBe(401);
    const app2 = make(nothing());
    const res = await get(app2, await login(app2, 'user-a'), '/api/v1/trips/trip_pdf/maps-links');
    expect(res.statusCode).toBe(422);
    expect(ApiError.parse(res.json()).code).toBe('RESTRICTED_ASSET');
  });
});
