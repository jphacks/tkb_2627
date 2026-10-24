import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, LoginResponse } from '@tkb/contracts';
import { createUser, migrate, openDatabase } from '@tkb/db';
import { buildApp } from '../src/platform/app.ts';
import { requireActor } from '../src/platform/auth/index.ts';
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

async function make(env: Record<string, string> = {}) {
  const db = openDatabase(':memory:');
  migrate(db);
  for (const [id, login] of [['user_a', 'demo-a'], ['user_b', 'demo-b']]) {
    createUser(db, { id: id!, loginId: login!, passwordHash: pwHash, displayName: `name ${login}`, createdAt: new Date().toISOString() });
  }
  const config = { ...loadConfig({ SESSION_SECRET: 's'.repeat(40), ...env }), databasePath: ':memory:' };
  const app = buildApp({ config, db });
  app.post('/api/v1/_test/write', { preHandler: app.authenticate }, async (req) => ({ who: requireActor(req).userId }));
  apps.push(app);
  return { app, db };
}
type App = Awaited<ReturnType<typeof make>>['app'];

const login = (app: App, loginId = 'demo-a', password = PW, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId, password }, headers });
const cookieOf = (res: { headers: Record<string, unknown> }) =>
  String(res.headers['set-cookie']).split(';')[0]!;
const tokenOf = (res: { headers: Record<string, unknown> }) => cookieOf(res).split('=')[1]!;

describe('login and cookie', () => {
  it('sets a hardened cookie and stores only the hash', async () => {
    const { app, db } = await make();
    const res = await login(app);
    expect(res.statusCode).toBe(200);
    const body = LoginResponse.parse(res.json());
    expect(body.userId).toBe('user_a');
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Secure/i);
    expect(res.headers['cache-control']).toBe('no-store');
    const token = tokenOf(res);
    const rows = db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id_hash).not.toContain(token);
    expect(rows[0]!.id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.prepare('SELECT * FROM users').all())).not.toContain(PW);
  });
  it('Secure cookie when PUBLIC_ORIGIN is https', async () => {
    const { app } = await make({ PUBLIC_ORIGIN: 'https://app.example' });
    const res = await login(app, 'demo-a', PW, { origin: 'https://app.example' });
    expect(String(res.headers['set-cookie'])).toMatch(/Secure/i);
  });
  it('https without SESSION_SECRET refuses to start', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'https://app.example' })).toThrow(/SESSION_SECRET/);
  });
});

describe('failures and rate limit', () => {
  it('wrong password and unknown id look identical; 6th attempt is 429', async () => {
    const { app } = await make();
    const a = await login(app, 'demo-a', 'wrong-password-1');
    const b = await login(app, 'nobody', 'wrong-password-1');
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(ApiError.parse(a.json()).message).toBe(ApiError.parse(b.json()).message);
    expect(a.headers['set-cookie']).toBeUndefined();
    for (let i = 0; i < 4; i++) await login(app, 'demo-a', 'wrong-password-2');
    const limited = await login(app, 'demo-a', PW); // even the right password is refused now
    expect(limited.statusCode).toBe(429);
    const e = ApiError.parse(limited.json());
    expect(e.code).toBe('RATE_LIMITED');
    expect(typeof e.details?.retryAfterMs).toBe('number');
  });
  it('success resets the per-login counter', async () => {
    const { app } = await make();
    for (let i = 0; i < 4; i++) await login(app, 'demo-a', 'wrong-password-3');
    expect((await login(app)).statusCode).toBe(200);
    // the login counter was reset, so another failure is allowed
    expect((await login(app, 'demo-a', 'wrong-password-3')).statusCode).toBe(401);
  });
  it('parallel wrong-password logins cannot bypass the limit', async () => {
    const { app } = await make();
    const rs = await Promise.all(Array.from({ length: 10 }, () => login(app, 'demo-a', 'wrong-password-4')));
    const codes = rs.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(5);
    expect(codes.filter((c) => c === 401).length).toBeLessThanOrEqual(5);
  });
  it('IP limit is higher than the per-login limit', async () => {
    const { app } = await make();
    for (let i = 0; i < 20; i++) expect((await login(app, `user-${i}`, 'wrong-password-5')).statusCode).toBe(401);
  });
  it('loginId is case-insensitive', async () => {
    const { app } = await make();
    expect((await login(app, 'DEMO-A')).statusCode).toBe(200);
  });
  it('text/plain login body is 422', async () => {
    const { app } = await make();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify({ loginId: 'demo-a', password: PW }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
  it('rejects malformed body without echoing it', async () => {
    const { app } = await make();
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'x', password: PW, extra: 1 } });
    expect(res.statusCode).toBe(422);
    expect(res.body).not.toContain(PW);
  });
});

describe('session lifecycle', () => {
  it('me works, logout revokes, same cookie then 401', async () => {
    const { app, db } = await make();
    const res = await login(app);
    const cookie = cookieOf(res);
    const csrf = LoginResponse.parse(res.json()).csrfToken;
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(LoginResponse.parse(me.json()).csrfToken).toBe(csrf);
    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': csrf } });
    expect(out.statusCode).toBe(204);
    expect((db.prepare('SELECT revoked_at FROM sessions').get() as { revoked_at: string | null }).revoked_at).toBeTruthy();
    const again = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
    expect(again.statusCode).toBe(401);
    expect(ApiError.parse(again.json()).code).toBe('UNAUTHENTICATED');
  });
  it('expired session is 401', async () => {
    const { app, db } = await make();
    const cookie = cookieOf(await login(app));
    db.prepare('UPDATE sessions SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie } })).statusCode).toBe(401);
  });
  it('unauthenticated /me is 401', async () => {
    const { app } = await make();
    expect((await app.inject('/api/v1/auth/me')).statusCode).toBe(401);
  });
  it('forged, guessed and tampered cookies are 401', async () => {
    const { app, db } = await make();
    const res = await login(app);
    const token = tokenOf(res);
    const hash = (db.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string }).id_hash;
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    for (const v of [flipped, hash, 'x'.repeat(43), 'abc', token + 'x']) {
      const r = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: `tkb_session=${v}` } });
      expect(r.statusCode).toBe(401);
    }
  });
  it('sessions are bound to their own user', async () => {
    const { app } = await make();
    const a = await login(app, 'demo-a');
    const b = await login(app, 'demo-b');
    const csrf = (r: typeof a) => LoginResponse.parse(r.json()).csrfToken;
    const ra = await app.inject({ method: 'POST', url: '/api/v1/_test/write', headers: { cookie: cookieOf(a), 'x-csrf-token': csrf(a) } });
    const rb = await app.inject({ method: 'POST', url: '/api/v1/_test/write', headers: { cookie: cookieOf(b), 'x-csrf-token': csrf(b) } });
    expect(ra.json()).toEqual({ who: 'user_a' });
    expect(rb.json()).toEqual({ who: 'user_b' });
    // A's cookie with B's CSRF token is rejected.
    const cross = await app.inject({ method: 'POST', url: '/api/v1/_test/write', headers: { cookie: cookieOf(a), 'x-csrf-token': csrf(b) } });
    expect(cross.statusCode).toBe(403);
  });
});

describe('CSRF and Origin', () => {
  it('missing/mismatched token 403, correct passes, no cookie 401', async () => {
    const { app } = await make();
    const res = await login(app);
    const cookie = cookieOf(res);
    const csrf = LoginResponse.parse(res.json()).csrfToken;
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/v1/_test/write', headers });
    const missing = await post({ cookie });
    expect(missing.statusCode).toBe(403);
    expect(ApiError.parse(missing.json()).code).toBe('FORBIDDEN');
    expect((await post({ cookie, 'x-csrf-token': 'nope' })).statusCode).toBe(403);
    expect((await post({ cookie, 'x-csrf-token': csrf })).statusCode).toBe(200);
    expect((await post({ cookie, 'x-csrf-token': csrf, origin: 'http://localhost:5173' })).statusCode).toBe(200);
    expect((await post({ cookie, 'x-csrf-token': csrf, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({})).statusCode).toBe(401);
    // logout also needs the token
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } })).statusCode).toBe(403);
  });
  it('cross-origin login is refused', async () => {
    const { app } = await make();
    expect((await login(app, 'demo-a', PW, { origin: 'https://evil.example' })).statusCode).toBe(403);
  });
  it('dev origins are not allowed once PUBLIC_ORIGIN is set', async () => {
    const { app } = await make({ PUBLIC_ORIGIN: 'https://app.example' });
    expect((await login(app, 'demo-a', PW, { origin: 'http://localhost:5173' })).statusCode).toBe(403);
  });
});

describe('hardening', () => {
  it('PUT/PATCH/DELETE require CSRF', async () => {
    const { app } = await make();
    app.put('/api/v1/_test/m', { preHandler: app.authenticate }, async () => ({ ok: 1 }));
    app.patch('/api/v1/_test/m', { preHandler: app.authenticate }, async () => ({ ok: 1 }));
    app.delete('/api/v1/_test/m', { preHandler: app.authenticate }, async () => ({ ok: 1 }));
    const res = await login(app);
    const cookie = cookieOf(res);
    const csrf = LoginResponse.parse(res.json()).csrfToken;
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const url = '/api/v1/_test/m';
      expect((await app.inject({ method, url, headers: { cookie } })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: { cookie, 'x-csrf-token': csrf } })).statusCode).toBe(200);
    }
  });
  it('unguarded /api/v1 routes are refused at registration', async () => {
    const { app } = await make();
    expect(() => app.get('/api/v1/oops', async () => 1)).toThrow(/authenticate/);
    expect(() => app.post('/api/v1/oops2', async () => 1)).toThrow(/authenticate/);
  });
  it('https uses the __Host- cookie name', async () => {
    const { app } = await make({ PUBLIC_ORIGIN: 'https://app.example' });
    const res = await login(app, 'demo-a', PW, { origin: 'https://app.example' });
    const sc = String(res.headers['set-cookie']);
    expect(sc).toMatch(/^__Host-tkb_session=/);
    expect(sc).toMatch(/Path=\//);
    expect(sc).not.toMatch(/Domain/i);
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: cookieOf(res) } });
    expect(me.statusCode).toBe(200);
  });
  it('login revokes a previous session cookie', async () => {
    const { app } = await make();
    const first = cookieOf(await login(app));
    await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'demo-a', password: PW }, headers: { cookie: first } });
    expect((await app.inject({ url: '/api/v1/auth/me', headers: { cookie: first } })).statusCode).toBe(401);
  });
  it('config: PUBLIC_ORIGIN and TRUST_PROXY validation', () => {
    const base = { SESSION_SECRET: 's'.repeat(40) };
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://example.com' })).toThrow(/PUBLIC_ORIGIN/);
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: 'http://localhost:5173' }).publicOrigin).toBe('http://localhost:5173');
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig({ ...base, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(loadConfig(base).trustProxy).toBe(false);
  });
});

describe('secrets', () => {
  it('password and token never appear in responses', async () => {
    const { app } = await make();
    const bad = await login(app, 'demo-a', 'wrong-password-9');
    const ok = await login(app);
    const token = tokenOf(ok);
    for (const r of [bad, ok]) {
      expect(r.body).not.toContain('wrong-password-9');
      expect(r.body).not.toContain(PW);
      expect(r.body).not.toContain(token);
      expect(r.body).not.toContain('scrypt$');
    }
    const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie: cookieOf(ok) } });
    expect(me.body).not.toContain(token);
  });
  it('verifyPassword failures do not throw secrets', async () => {
    const { verifyPassword } = await import('../src/platform/auth/password.ts');
    expect(await verifyPassword(PW, 'garbage')).toBe(false);
    expect(await verifyPassword(PW, 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('create-user script', () => {
  it('creates via TKB_NEW_PASSWORD, fails on duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tkb-user-'));
    try {
      const run = (pw: string | undefined) =>
        spawnSync(process.execPath, ['scripts/create-user.mjs', '--login', 'demo-x', '--name', 'X'], {
          cwd: new URL('../../../', import.meta.url),
          env: { ...process.env, DATABASE_PATH: join(dir, 't.sqlite'), ...(pw ? { TKB_NEW_PASSWORD: pw } : {}) },
          encoding: 'utf8',
          input: '',
        });
      const first = run('a-long-enough-pass');
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).not.toContain('a-long-enough-pass');
      const dup = run('a-long-enough-pass');
      expect(dup.status).toBe(1);
      expect(dup.stderr).toMatch(/already exists/);
      expect(dup.stderr).not.toContain('a-long-enough-pass');
      expect(run('short').status).toBe(1);
      // loginId is normalized to lower case, so a different case is a duplicate
      const upper = spawnSync(process.execPath, ['scripts/create-user.mjs', '--login', 'DEMO-X', '--name', 'X'], {
        cwd: new URL('../../../', import.meta.url),
        env: { ...process.env, DATABASE_PATH: join(dir, 't.sqlite'), TKB_NEW_PASSWORD: 'a-long-enough-pass' },
        encoding: 'utf8',
        input: '',
      });
      expect(upper.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
