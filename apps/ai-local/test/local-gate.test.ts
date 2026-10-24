import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, JobAccepted, JobStatus } from '@tkb/contracts';
import { FakeRunner, type FakeFailureMode } from '@tkb/ai';
import { samplePlanBlueprint } from '@tkb/fixtures';
import { buildApp } from '../src/app.ts';
import { PairingStore } from '../src/auth/pairing.ts';
import { loadConfig, type PersonalConfig } from '../src/config.ts';
import type { FetchLike } from '../src/shared-client/index.ts';

const HOST = '127.0.0.1:4311';
const ORIGIN = 'http://127.0.0.1:4311';
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const constraints = { area: 'Kanazawa; rm -rf / $(id)', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };
const placeIds = samplePlanBlueprint.candidates.flatMap(c => c.activityOrder);

interface Calls { url: string; init: RequestInit }
function loginFetch(userId: string, status = 200, calls: Calls[] = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('{}', { status });
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'tkb_sid=UPSTREAMSECRET; HttpOnly; Path=/');
    return new Response(JSON.stringify({ userId, displayName: 'Taro', csrfToken: 'UPSTREAMCSRF' }), { status: 200, headers: h });
  };
}

function make(o: { failure?: FakeFailureMode; config?: Partial<PersonalConfig>; fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {}) {
  const config = { ...loadConfig({ PERSONAL_ALLOWED_USER_IDS: 'u1, u2', ...o.env }), ...o.config };
  const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
  const app = buildApp({
    config,
    pairing,
    runner: new FakeRunner({ failure: o.failure }),
    fetch: o.fetch ?? loginFetch('u1'),
    allowedPlaceIds: placeIds,
  });
  apps.push(app);
  return { app, pairing };
}

type App = ReturnType<typeof make>;
const post = (a: App, url: string, payload: unknown, headers: Record<string, string> = {}) =>
  a.app.inject({ method: 'POST', url, payload: payload as object, headers: { host: HOST, origin: ORIGIN, ...headers } });

async function pair(a: App) {
  const r = await post(a, '/local/v1/pair', { code: a.pairing.issue() });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  return { cookie, csrf: (r.json() as { csrfToken: string }).csrfToken, res: r };
}
async function session(a: App, userId = 'u1') {
  void userId;
  const s = await pair(a);
  const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
  const l = await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, h);
  expect(l.statusCode).toBe(200);
  return { ...s, h };
}
const gen = (a: App, h: Record<string, string>, key = 'key-12345678', body: unknown = { constraints }) =>
  post(a, '/local/v1/generations', body, { ...h, 'idempotency-key': key });
const code = (r: { json(): unknown }) => ApiError.parse(r.json()).code;

async function waitState(a: App, h: Record<string, string>, jobId: string, state: string) {
  for (let i = 0; i < 100; i++) {
    const r = await a.app.inject({ url: `/local/v1/jobs/${jobId}`, headers: { host: HOST, ...h } });
    const j = JobStatus.parse(r.json());
    if (j.state === state) return j;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('timeout waiting for state ' + state);
}

describe('pairing and CSRF', () => {
  it('sets an HttpOnly SameSite=Strict cookie and never leaks the code', async () => {
    const a = make();
    const s = await pair(a);
    const c = String(s.res.headers['set-cookie']);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Strict/);
    expect(c).toMatch(/Path=\/local/);
    expect(s.csrf.length).toBeGreaterThan(20);
  });
  it('rejects POST with missing or foreign Origin and cross-site fetch metadata', async () => {
    const a = make();
    const code = a.pairing.issue();
    const noOrigin = await a.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code }, headers: { host: HOST } });
    expect(noOrigin.statusCode).toBe(403);
    const evil = await post(a, '/local/v1/pair', { code }, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    const cross = await post(a, '/local/v1/pair', { code }, { 'sec-fetch-site': 'cross-site' });
    expect(cross.statusCode).toBe(403);
    const forgedHost = await a.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code }, headers: { host: 'evil.example', origin: ORIGIN } });
    expect(forgedHost.statusCode).toBe(403);
    // the code was never consumed by rejected requests
    const same = await a.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code }, headers: { host: HOST, 'sec-fetch-site': 'same-origin' } });
    expect(same.statusCode).toBe(200);
  });
  it('wrong code is 403, attempt limit locks the code, reuse and expiry fail', async () => {
    const a = make();
    const good = a.pairing.issue();
    for (let i = 0; i < 4; i++) expect((await post(a, '/local/v1/pair', { code: 'WRONG' + i })).statusCode).toBe(403);
    const fifth = await post(a, '/local/v1/pair', { code: 'WRONG5' });
    expect(fifth.statusCode).toBe(429);
    expect((await post(a, '/local/v1/pair', { code: good })).statusCode).toBe(429);

    const b = make();
    await pair(b);
    const reuse = await post(b, '/local/v1/pair', { code: 'ANYTHING' });
    expect(reuse.statusCode).toBe(429);

    let t = 1000;
    const p = new PairingStore({ ttlMs: 100, now: () => t });
    const c = p.issue();
    t += 101;
    expect(p.verify(c)).toBe('locked');
  });
  it('unpaired is 401; missing or wrong CSRF is 403', async () => {
    const a = make();
    expect((await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' })).statusCode).toBe(401);
    expect((await post(a, '/local/v1/generations', {}, { cookie: 'tkb_local_sid=forged' })).statusCode).toBe(401);
    const s = await pair(a);
    const body = { loginId: 'a', password: 'b' };
    expect((await post(a, '/local/v1/auth/login', body, { cookie: s.cookie })).statusCode).toBe(403);
    const bad = await post(a, '/local/v1/auth/login', body, { cookie: s.cookie, 'x-csrf-token': 'nope' });
    expect(bad.statusCode).toBe(403);
    expect(code(bad)).toBe('FORBIDDEN');
  });
});

describe('login proxy', () => {
  it('forwards only to the fixed path, hides upstream cookie and csrf', async () => {
    const calls: Calls[] = [];
    const a = make({ fetch: loginFetch('u1', 200, calls) });
    const s = await pair(a);
    const r = await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, { cookie: s.cookie, 'x-csrf-token': s.csrf, authorization: 'Bearer x', 'x-forwarded-for': '1.2.3.4' });
    expect(r.json()).toEqual({ userId: 'u1', displayName: 'Taro' });
    expect(JSON.stringify(r.headers)).not.toContain('UPSTREAM');
    expect(r.body).not.toContain('UPSTREAM');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:4310/api/v1/auth/login');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json' });
  });
  it('does not proxy arbitrary paths or extra body fields', async () => {
    const calls: Calls[] = [];
    const a = make({ fetch: loginFetch('u1', 200, calls) });
    const s = await pair(a);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    expect((await post(a, '/local/v1/proxy/api/v1/trips', {}, h)).statusCode).toBe(404);
    expect((await post(a, '/local/v1/auth/login/../../x', {}, h)).statusCode).toBe(404);
    expect((await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b', url: 'http://evil' }, h)).statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });
  it('rejects users outside the allowlist and discards the session', async () => {
    const a = make({ fetch: loginFetch('stranger') });
    const s = await pair(a);
    const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
    const r = await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, h);
    expect(r.statusCode).toBe(403);
    expect((await gen(a, h)).statusCode).toBe(401);
    const empty = make({ env: { PERSONAL_ALLOWED_USER_IDS: '' } });
    const s2 = await pair(empty);
    expect((await post(empty, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, { cookie: s2.cookie, 'x-csrf-token': s2.csrf })).statusCode).toBe(403);
  });
  it('maps upstream 401/429/5xx', async () => {
    for (const [status, expected] of [[401, 'UNAUTHENTICATED'], [429, 'RATE_LIMITED'], [500, 'UNAVAILABLE']] as const) {
      const a = make({ fetch: loginFetch('u1', status) });
      const s = await pair(a);
      const r = await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, { cookie: s.cookie, 'x-csrf-token': s.csrf });
      expect(code(r)).toBe(expected);
    }
    const a = make({ fetch: async () => { throw new Error('boom secret'); } });
    const s = await pair(a);
    const r = await post(a, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, { cookie: s.cookie, 'x-csrf-token': s.csrf });
    expect(code(r)).toBe('UNAVAILABLE');
    expect(r.body).not.toContain('boom');
  });
});

describe('generation gate', () => {
  it('requires upstream login', async () => {
    const a = make();
    const s = await pair(a);
    const r = await gen(a, { cookie: s.cookie, 'x-csrf-token': s.csrf });
    expect(r.statusCode).toBe(401);
  });
  it('validates key, ownerId, unknown fields and malformed JSON', async () => {
    const a = make();
    const { h } = await session(a);
    expect((await gen(a, h, 'short')).statusCode).toBe(422);
    expect((await post(a, '/local/v1/generations', { constraints }, h)).statusCode).toBe(422);
    const owner = await gen(a, h, 'key-12345678', { constraints, ownerId: 'u2' });
    expect(owner.statusCode).toBe(422);
    expect(code(owner)).toBe('VALIDATION_FAILED');
    const bad = await a.app.inject({
      method: 'POST', url: '/local/v1/generations', payload: '{"constraints":',
      headers: { host: HOST, origin: ORIGIN, ...h, 'content-type': 'application/json', 'idempotency-key': 'key-12345678' },
    });
    expect(bad.statusCode).toBe(422);
    expect(code(bad)).toBe('VALIDATION_FAILED');
  });
  it('same key+body returns the same job, different body conflicts', async () => {
    const a = make({ failure: 'timeout' });
    const { h } = await session(a);
    const r1 = await gen(a, h);
    expect(r1.statusCode).toBe(202);
    const j1 = JobAccepted.parse(r1.json());
    const j2 = JobAccepted.parse((await gen(a, h)).json());
    expect(j2.jobId).toBe(j1.jobId);
    const diff = await gen(a, h, 'key-12345678', { constraints: { ...constraints, area: 'Other' } });
    expect(diff.statusCode).toBe(409);
    expect(code(diff)).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('hides jobs from other owners', async () => {
    const a = make({
      failure: 'timeout',
      fetch: async (_u, init) => loginFetch(JSON.parse(String(init.body)).loginId)(_u, init),
    });
    const login = async (loginId: string) => {
      const s = await pair(a);
      const h = { cookie: s.cookie, 'x-csrf-token': s.csrf };
      expect((await post(a, '/local/v1/auth/login', { loginId, password: 'b' }, h)).statusCode).toBe(200);
      return h;
    };
    const h1 = await login('u1');
    const h2 = await login('u2');
    const id = JobAccepted.parse((await gen(a, h1)).json()).jobId;
    const mine = await a.app.inject({ url: `/local/v1/jobs/${id}`, headers: { host: HOST, cookie: h1.cookie } });
    expect(mine.statusCode).toBe(200);
    const other = await a.app.inject({ url: `/local/v1/jobs/${id}`, headers: { host: HOST, cookie: h2.cookie } });
    expect(other.statusCode).toBe(404);
    expect((await post(a, `/local/v1/jobs/${id}/cancel`, undefined, h2)).statusCode).toBe(404);
    // same idempotency key under another owner is a separate job
    expect(JobAccepted.parse((await gen(a, h2)).json()).jobId).not.toBe(id);
    expect((await a.app.inject({ url: `/local/v1/jobs/${id}`, headers: { host: HOST } })).statusCode).toBe(401);
  });
  it('queue full is 429 QUEUE_FULL', async () => {
    const a = make({ failure: 'timeout', config: { aiQueueLimit: 1, aiTimeoutMs: 60_000 } });
    const { h } = await session(a);
    expect((await gen(a, h, 'key-00000001')).statusCode).toBe(202);
    expect((await gen(a, h, 'key-00000002')).statusCode).toBe(202);
    const full = await gen(a, h, 'key-00000003');
    expect(full.statusCode).toBe(429);
    expect(code(full)).toBe('QUEUE_FULL');
  });
  it('timeout -> CLI_TIMEOUT', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 30 } });
    const { h } = await session(a);
    const id = JobAccepted.parse((await gen(a, h)).json()).jobId;
    const j = await waitState(a, h, id, 'failed');
    expect(j.error?.code).toBe('CLI_TIMEOUT');
  });
  it('invalid output, exit error map to SafeError codes without raw text', async () => {
    const a = make({ failure: 'invalid_json' });
    const { h } = await session(a);
    const id = JobAccepted.parse((await gen(a, h)).json()).jobId;
    expect((await waitState(a, h, id, 'failed')).error?.code).toBe('INVALID_OUTPUT');
    const b = make({ failure: 'exit_nonzero' });
    const sb = await session(b);
    const idb = JobAccepted.parse((await gen(b, sb.h)).json()).jobId;
    expect((await waitState(b, sb.h, idb, 'failed')).error?.code).toBe('CLI_EXIT');
  });
  it('valid fake output is never reported succeeded (saving needs S04)', async () => {
    const a = make();
    const { h } = await session(a);
    const id = JobAccepted.parse((await gen(a, h)).json()).jobId;
    const j = await waitState(a, h, id, 'failed');
    expect(j.error?.code).toBe('UNAVAILABLE');
    expect(j.batchId).toBeNull();
  });
  it('cancel aborts a running job', async () => {
    const a = make({ failure: 'timeout', config: { aiTimeoutMs: 60_000 } });
    const { h } = await session(a);
    const id = JobAccepted.parse((await gen(a, h)).json()).jobId;
    const r = await post(a, `/local/v1/jobs/${id}/cancel`, undefined, h);
    expect(r.statusCode).toBe(200);
    expect((r.json() as { state: string }).state).toBe('cancelled');
    expect((await waitState(a, h, id, 'cancelled')).error).toBeNull();
    expect((await post(a, `/local/v1/jobs/${id}/cancel`, undefined, { cookie: h.cookie })).statusCode).toBe(403);
  });
});

describe('capabilities', () => {
  it('stays unavailable even when execution is allowed', async () => {
    const a = make({ env: { ALLOW_CLAUDE_EXECUTION: 'true' } });
    const c = (await a.app.inject({ url: '/local/v1/capabilities', headers: { host: HOST } })).json() as { aiGeneration: unknown };
    expect(c.aiGeneration).toEqual({ available: false, runner: 'fake', reason: 'TERMS_NOT_CONFIRMED' });
  });
});

describe('static safety', () => {
  it('no child_process in ai-local/ai sources', () => {
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = [...walk(join(__dirname, '../src')), ...walk(join(__dirname, '../../../packages/ai/src'))].filter(f => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/child_process|\bspawn\(|\bexecFile?\(/);
  });
});
