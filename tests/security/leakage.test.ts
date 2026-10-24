// T05-4/5: log and response leakage. Failure paths must not reveal passwords, tokens, cookie values, stacks, paths or DB errors.
import type { InjectOptions } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp as buildLocal } from '../../apps/ai-local/src/app.ts';
import { PairingStore } from '../../apps/ai-local/src/auth/pairing.ts';
import { loadConfig as loadLocal } from '../../apps/ai-local/src/config.ts';
import { ApiError } from '@tkb/contracts';
import { PW, ROOT, makeShared, read, rel, sourceFiles } from './helpers.ts';

const apps: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (apps.length) await apps.pop()!.close();
});

const SECRETS = { pw: 'WRONG-PASSWORD-MARK-7', thrown: 'THROWN-SECRET-MARK-9', path: '/Users/tf-co0064/secret/dir' };
type Res = { statusCode: number; payload: string; headers: Record<string, unknown> };
/** Everything the client can see, as one string. */
const wire = (r: Res) => `${r.statusCode}\n${JSON.stringify(r.headers)}\n${r.payload}`;
const NO_INTERNALS = [/\n\s+at\s+\S+.*(:\d+:\d+|<anonymous>)/, /node_modules/, /\/Users\//, /\/private\/tmp/, /\.ts:\d+/, /better-sqlite|node:sqlite|SQLITE_|sqlite3/i, /ReferenceError|TypeError|RangeError|SyntaxError/, /x-powered-by/i];
const expectClean = (r: Res, where: string, extra: (string | RegExp)[] = []) => {
  const w = wire(r);
  for (const re of NO_INTERNALS) expect(w, `${where} ${re}`).not.toMatch(re);
  for (const s of [SECRETS.pw, SECRETS.thrown, SECRETS.path, ROOT, ...extra]) {
    if (typeof s === 'string') expect(w, `${where} ${s}`).not.toContain(s);
    else expect(w, `${where} ${s}`).not.toMatch(s);
  }
};

/** Capture every console / stdio write for the duration of a callback. */
async function captureLogs(f: () => Promise<void>): Promise<string> {
  const out: string[] = [];
  const push = (...a: unknown[]) => void out.push(a.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) vi.spyOn(console, m).mockImplementation(push);
  vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (push(String(c)), true)) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (push(String(c)), true)) as never);
  try { await f(); } finally { vi.restoreAllMocks(); }
  return out.join('\n');
}

const sharedWithBoom = async (env: Record<string, string> = {}) => {
  const s = await makeShared(env);
  apps.push(s.app);
  const g = { preHandler: s.app.authenticate };
  s.app.get('/api/v1/_t05/boom', g, async () => { throw new Error(`boom ${SECRETS.thrown} at ${SECRETS.path}/x.ts password=${SECRETS.pw}`); });
  s.app.get('/api/v1/_t05/boom-sync', g, () => { throw new TypeError(`${SECRETS.thrown} ${SECRETS.path}`); });
  s.app.get('/api/v1/_t05/boom-4xx', g, async () => { throw Object.assign(new Error(`client ${SECRETS.thrown}`), { statusCode: 400 }); });
  s.app.get('/api/v1/_t05/boom-5xx', g, async () => { throw Object.assign(new Error(`upstream ${SECRETS.thrown}`), { statusCode: 502 }); });
  s.app.get('/api/v1/_t05/boom-obj', g, async () => { throw { secret: SECRETS.thrown, stack: SECRETS.path }; }); // eslint-disable-line no-throw-literal
  s.app.get('/api/v1/_t05/db', g, async () => { s.db.prepare('SELECT * FROM table_that_does_not_exist_' + SECRETS.thrown.replace(/\W/g, '_')).all(); });
  await s.app.ready();
  const lr = await s.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
  const cookie = String(lr.headers['set-cookie']).split(';')[0]!;
  return { ...s, cookie, csrf: lr.json().csrfToken as string, h: { cookie } };
};

describe('T05-4 shared server: no log output and no leaking 5xx', () => {
  it('the loggers are off in both apps (source pin) and the only console calls are startup lines', () => {
    for (const f of ['apps/server/src/platform/app.ts', 'apps/ai-local/src/app.ts']) expect(read(`${ROOT}/${f}`), f).toMatch(/logger:\s*false/);
    const calls: string[] = [];
    for (const f of sourceFiles(['apps/server/src', 'apps/ai-local/src', 'packages/db/src', 'packages/ai/src', 'packages/contracts/src'], { skipTests: true })) {
      for (const m of read(f).matchAll(/console\.\w+\(([\s\S]*?)\);/g)) calls.push(`${rel(f)}: ${m[0].replace(/\s+/g, ' ')}`);
    }
    // Every call is a fixed message (no interpolated secret-looking value). Pairing code on the terminal is by design (A02).
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).not.toMatch(/\$\{[^}]*(password|token|cookie|csrf|secret|session)[^}]*\}/i);
  });

  it('throwing handlers produce a generic K23 500 with no message, stack, path or secret, and nothing is logged', async () => {
    const { app, h } = await sharedWithBoom();
    const logs = await captureLogs(async () => {
      for (const p of ['boom', 'boom-sync', 'boom-5xx', 'boom-obj', 'db']) {
        const r = await app.inject({ url: `/api/v1/_t05/${p}`, headers: h });
        expect(r.statusCode, p).toBe(500);
        const e = ApiError.parse(r.json());
        expect(e.code).toBe('INTERNAL');
        expect(e.message).toBe('Internal error.');
        expect(e.details).toBeUndefined();
        expectClean(r, p);
      }
      const r4 = await app.inject({ url: '/api/v1/_t05/boom-4xx', headers: h });
      expect(r4.statusCode).toBe(422);
      expectClean(r4, 'boom-4xx');
    });
    expect(logs).toBe('');
  });

  it('a closed database (storage failure) is a generic error, not a SQLite message or path', async () => {
    const { app, db, cookie } = await sharedWithBoom();
    db.close();
    const logs = await captureLogs(async () => {
      for (const [method, url] of [['GET', '/api/v1/auth/me'], ['GET', '/api/v1/health'], ['GET', '/api/v1/trips'], ['POST', '/api/v1/auth/login']] as const) {
        const r = await app.inject({ method, url, headers: { cookie }, payload: method === 'POST' ? { loginId: 'user-a', password: SECRETS.pw } : undefined });
        expect(r.statusCode, url).toBeGreaterThanOrEqual(400);
        expectClean(r, url, [cookie.split('=')[1]!]);
      }
    });
    expect(logs).toBe('');
  });

  it('failure responses (login wrong/unknown/malformed, CSRF, Origin, 429) leak no password, token, cookie value or login id, and log nothing', async () => {
    const { app, cookie, csrf } = await sharedWithBoom();
    const cookieValue = cookie.split('=')[1]!;
    const secrets = [cookieValue, csrf, PW];
    const logs = await captureLogs(async () => {
      const cases: [string, Res][] = [];
      const add = async (name: string, p: InjectOptions) => cases.push([name, (await app.inject(p)) as unknown as Res]);
      await add('wrong pw', { method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: SECRETS.pw } });
      await add('unknown id', { method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'nobody-x', password: SECRETS.pw } });
      await add('malformed', { method: 'POST', url: '/api/v1/auth/login', payload: `{"loginId":"a","password":"${SECRETS.pw}"`, headers: { 'content-type': 'application/json' } });
      await add('bad origin', { method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: SECRETS.pw }, headers: { origin: 'https://evil.example' } });
      await add('no csrf', { method: 'POST', url: '/api/v1/auth/logout', headers: { cookie } });
      await add('bad csrf', { method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, 'x-csrf-token': `${csrf}x` } });
      await add('forged cookie', { url: '/api/v1/auth/me', headers: { cookie: `${cookie.split('=')[0]}=${cookieValue.slice(0, -2)}zz` } });
      await add('wrong method', { method: 'PUT', url: '/api/v1/auth/login' });
      for (let i = 0; i < 6; i++) await add(`limit ${i}`, { method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: SECRETS.pw } });
      for (const [name, r] of cases) {
        expectClean(r, name);
        // the real session's secrets are never echoed on a failure path
        for (const s of secrets) expect(wire(r), `${name} secret`).not.toContain(s);
        expect(r.headers['set-cookie'], name).toBeUndefined();
        if (r.statusCode >= 400) expect(() => ApiError.parse(JSON.parse(r.payload)), name).not.toThrow();
      }
      expect(cases.some(([, r]) => r.statusCode === 429)).toBe(true);
    });
    expect(logs).toBe('');
  });

  it('successful login logs nothing and the password/session hash never appears in any later response', async () => {
    const { app } = await sharedWithBoom();
    const logs = await captureLogs(async () => {
      const r = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
      expect(r.statusCode).toBe(200);
      expect(wire(r)).not.toContain(PW);
      const cookie = String(r.headers['set-cookie']).split(';')[0]!;
      const me = await app.inject({ url: '/api/v1/auth/me', headers: { cookie } });
      expect(wire(me)).not.toMatch(/passwordHash|scrypt|\$argon|idHash/i);
      expect(wire(me)).not.toContain(PW);
    });
    expect(logs).toBe('');
  });

  it('the headers of every response carry no server banner or internal detail', async () => {
    const { app, h } = await sharedWithBoom();
    for (const url of ['/api/v1/health', '/api/v1/_t05/boom', '/nope', '/api/v1/auth/me']) {
      const r = await app.inject({ url, headers: h });
      for (const h of ['server', 'x-powered-by', 'via']) expect(r.headers[h], `${url} ${h}`).toBeUndefined();
      expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/); // a fresh UUID, never a client-supplied value
    }
    const echo = await app.inject({ url: '/api/v1/health', headers: { 'x-request-id': 'CLIENT-CHOSEN' } });
    expect(echo.headers['x-request-id']).not.toBe('CLIENT-CHOSEN');
  });
});

describe('T05-4 personal entry: 500s and failure paths leak nothing', () => {
  const H = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
  const UP = { cookie: 'tkb_sid=UPSTREAM-COOKIE-MARK', csrf: 'UPSTREAM-CSRF-MARK' };
  async function paired(fetchImpl: Parameters<typeof buildLocal>[0]['fetch']) {
    const pairing = new PairingStore({ ttlMs: 60_000 });
    const code = pairing.issue();
    const app = buildLocal({ config: loadLocal({ PERSONAL_OWNER_USER_ID: 'u1' }), pairing, fetch: fetchImpl });
    apps.push(app);
    app.get('/local/v1/_t05/boom', async () => { throw new Error(`boom ${SECRETS.thrown} ${SECRETS.path}`); });
    await app.ready();
    const p = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code }, headers: H });
    const cookie = String(p.headers['set-cookie']).split(';')[0]!;
    return { app, cookie, csrf: (p.json() as { csrfToken: string }).csrfToken, code };
  }

  it('throwing handler is a generic 500; upstream exceptions, 5xx bodies and bad JSON never surface; nothing is logged', async () => {
    const fetches = [
      async () => { throw new Error(`connect ECONNREFUSED ${SECRETS.path} ${SECRETS.thrown}`); },
      async () => new Response(`<html>${SECRETS.thrown} ${SECRETS.path} at Object.<anonymous> (/x.ts:1:1)</html>`, { status: 500 }),
      async () => new Response(`{not json ${SECRETS.thrown}`, { status: 200, headers: { 'set-cookie': `${UP.cookie}; HttpOnly` } }),
      async () => new Response(JSON.stringify({ userId: 'u9', displayName: 'X', csrfToken: UP.csrf }), { status: 200, headers: { 'set-cookie': `${UP.cookie}; HttpOnly` } }), // not the owner
    ];
    for (const f of fetches) {
      const c = await paired(f);
      const logs = await captureLogs(async () => {
        const boom = await c.app.inject({ url: '/local/v1/_t05/boom', headers: { host: H.host } });
        expect(boom.statusCode).toBe(500);
        expect(ApiError.parse(boom.json()).message).toBe('Internal error.');
        expectClean(boom as unknown as Res, 'local boom');
        const r = await c.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'u1', password: SECRETS.pw }, headers: { ...H, cookie: c.cookie, 'x-csrf-token': c.csrf } });
        expect(r.statusCode).toBeGreaterThanOrEqual(400);
        expectClean(r as unknown as Res, 'local login', [UP.cookie, UP.csrf, 'UPSTREAM', 'ECONNREFUSED']);
      });
      expect(logs).toBe('');
    }
  });

  it('pairing failures and CSRF failures reveal neither the code, the session cookie value, nor the csrf token', async () => {
    const c = await paired(async () => new Response('{}', { status: 401 }));
    const cookieValue = c.cookie.split('=')[1]!;
    const logs = await captureLogs(async () => {
      const rs = [
        await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: 'WRONG-CODE-MARK' }, headers: H }),
        await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: c.code }, headers: H }), // single use: already consumed
        await c.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: SECRETS.pw }, headers: { ...H, cookie: c.cookie } }),
        await c.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: SECRETS.pw }, headers: { ...H, cookie: c.cookie, 'x-csrf-token': 'nope' } }),
        await c.app.inject({ method: 'POST', url: '/local/v1/generations', payload: {}, headers: { ...H, cookie: 'tkb_local_sid=forged', 'x-csrf-token': c.csrf } }),
      ];
      for (const r of rs) {
        expectClean(r as unknown as Res, 'local failure', [c.code, 'WRONG-CODE-MARK', c.csrf, cookieValue]);
        expect(r.headers['set-cookie']).toBeUndefined();
      }
      // the session endpoint is the only place the csrf token is revealed, and only to the cookie holder
      const anon = await c.app.inject({ url: '/local/v1/session', headers: { host: H.host } });
      expect(anon.statusCode).toBe(401);
      expect(anon.payload).not.toContain(c.csrf);
    });
    expect(logs).toBe('');
  });
});

describe('T05-5 cookie attributes on the shared entry', () => {
  const attrs = (h: unknown) => String(h).split(';').map(s => s.trim());
  it('http development: HttpOnly, SameSite=Lax, Path=/, Max-Age, no Domain, not Secure-prefixed', async () => {
    const s = await makeShared();
    apps.push(s.app);
    const r = await s.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW } });
    const a = attrs(r.headers['set-cookie']);
    expect(a).toContain('HttpOnly');
    expect(a).toContain('SameSite=Lax');
    expect(a).toContain('Path=/');
    expect(a.some(x => /^Max-Age=\d+$/i.test(x))).toBe(true);
    expect(a.some(x => /^Domain=/i.test(x))).toBe(false);
    expect(a.some(x => /^SameSite=None/i.test(x))).toBe(false);
  });
  it('https public origin: __Host- name, Secure, HttpOnly, SameSite, Path=/, no Domain; logout clears with the same flags; HSTS present', async () => {
    const s = await makeShared({ PUBLIC_ORIGIN: 'https://demo.example.trycloudflare.com', TRUST_PROXY: 'loopback' });
    apps.push(s.app);
    const origin = 'https://demo.example.trycloudflare.com';
    const r = await s.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { loginId: 'user-a', password: PW }, headers: { origin } });
    expect(r.statusCode).toBe(200);
    const raw = String(r.headers['set-cookie']);
    expect(raw).toMatch(/^__Host-/);
    const a = attrs(raw);
    for (const need of ['Secure', 'HttpOnly', 'Path=/']) expect(a).toContain(need);
    expect(a.some(x => /^SameSite=(Lax|Strict)$/i.test(x))).toBe(true);
    expect(a.some(x => /^Domain=/i.test(x))).toBe(false);
    expect(String(r.headers['strict-transport-security'])).toMatch(/max-age=\d{7,}/);
    const out = await s.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { origin, cookie: raw.split(';')[0]!, 'x-csrf-token': r.json().csrfToken } });
    expect(out.statusCode).toBe(204);
    const c = attrs(out.headers['set-cookie']);
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c.some(x => /^(Max-Age=0|Expires=)/i.test(x))).toBe(true);
  });
  it('personal entry cookie is HttpOnly, SameSite=Strict, scoped to /local, and carries no Domain', async () => {
    const pairing = new PairingStore({ ttlMs: 1000 });
    const app = buildLocal({ config: loadLocal({ PERSONAL_OWNER_USER_ID: 'u1' }), pairing });
    apps.push(app);
    const r = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: H0 });
    const a = attrs(r.headers['set-cookie']);
    expect(a).toContain('HttpOnly');
    expect(a).toContain('SameSite=Strict');
    expect(a).toContain('Path=/local');
    expect(a.some(x => /^Domain=/i.test(x))).toBe(false);
  });
});
const H0 = { host: '127.0.0.1:4311', origin: 'http://127.0.0.1:4311' };
