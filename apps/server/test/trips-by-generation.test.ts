// A04 step 2: GET /api/v1/plan-batches?generationId=<id> (owner-scoped lookup for restart recovery).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { hashPassword } from '../src/platform/auth/password.ts';
import { loadConfig } from '../src/platform/config.ts';

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

function make() {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const id of ['user_a', 'user_b']) createUser(db, { id, loginId: id.replace('_', '-'), passwordHash: pwHash, displayName: id, createdAt: new Date().toISOString() });
  const app = buildApp({ config: { ...loadConfig({ SESSION_SECRET: 's'.repeat(40) }), databasePath: ':memory:' }, db });
  apps.push(app);
  return app;
}
async function login(app: App, loginId: string): Promise<Session> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password: PW } });
  return { cookie: String(res.headers['set-cookie']).split(';')[0]!, csrf: res.json().csrfToken };
}
const call = (app: App, s: Session, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf } });

const tz = 'Asia/Tokyo';
const body = (generationId: string) => ({
  schemaVersion: 1, baseTripId: null, baseRevision: null, generationId,
  candidates: [{
    candidateId: 'c1', title: 'Plan', days: [{ date: '2026-11-01', timeZone: tz, items: [] }],
    reasons: [], warnings: [], excludedPlaceIds: [], totalKnownCost: [], hasUnknownCost: true, validationState: 'needs_review',
  }],
  places: [],
  constraints: { area: 'Kyoto', startDate: '2026-11-01', endDate: '2026-11-01', timeZone: tz, transportMode: 'transit' },
});
const strip = (r: { json: () => unknown }) => ({ ...ApiError.parse(r.json()), requestId: '' });

describe('GET /api/v1/plan-batches?generationId=', () => {
  it('own batch 200 {batchId}; other owner and missing are the identical 404; no-store', async () => {
    const app = make();
    const a = await login(app, 'user-a');
    const b = await login(app, 'user-b');
    const created = await call(app, a, 'POST', '/api/v1/plan-batches', body('gen_abc12345'));
    expect(created.statusCode).toBe(201);
    const own = await call(app, a, 'GET', '/api/v1/plan-batches?generationId=gen_abc12345');
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ batchId: created.json().batchId });
    expect(own.headers['cache-control']).toBe('no-store');
    const other = await call(app, b, 'GET', '/api/v1/plan-batches?generationId=gen_abc12345');
    const missing = await call(app, a, 'GET', '/api/v1/plan-batches?generationId=gen_nothere1');
    expect(other.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(strip(other)).toEqual(strip(missing));
    expect(ApiError.parse(other.json()).code).toBe('NOT_FOUND');
    expect(other.headers['cache-control']).toBe('no-store');
  });

  it('bad query is 422 (missing, extra, malformed, repeated); unauthenticated is 401', async () => {
    const app = make();
    const a = await login(app, 'user-a');
    for (const q of ['', '?generationId=', '?generationId=bad%20id', '?generationId=gen_abc12345&x=1', '?x=1', '?generationId=a&generationId=b']) {
      const r = await call(app, a, 'GET', `/api/v1/plan-batches${q}`);
      expect(r.statusCode, q).toBe(422);
      expect(ApiError.parse(r.json()).code).toBe('VALIDATION_FAILED');
    }
    expect((await app.inject({ method: 'GET', url: '/api/v1/plan-batches?generationId=gen_abc12345' })).statusCode).toBe(401);
  });
});
