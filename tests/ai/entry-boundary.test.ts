// T04-6/7: key mixing and public-entry refusal at the system boundary.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Capabilities } from '@tkb/contracts';
import { buildApp as buildShared } from '../../apps/server/src/platform/app.ts';
import { loadConfig as loadShared } from '../../apps/server/src/platform/config.ts';
import { loadConfig } from '../../apps/ai-local/src/config.ts';
import { HOST, ORIGIN, UP_COOKIE, UP_CSRF, closeAll, codeOf, constraints, envelope, gen, loginFetch, make, ok, post, runnerOf, session, settle, submit } from './harness.ts';

const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEAPIKEY',
  ANTHROPIC_AUTH_TOKEN: 'FAKE-AUTH-TOKEN-ZZZ',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKEOAUTH',
};
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const [k, v] of Object.entries(KEYS)) { saved[k] = process.env[k]; process.env[k] = v; }
});
afterEach(async () => {
  for (const k of Object.keys(KEYS)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  await closeAll();
});

describe('key mixing (キー混入)', () => {
  it('capabilities never report available / claude-code even with billing env set (execution allowed too)', async () => {
    for (const allow of ['true', 'false']) {
      const c = make({ env: { ...KEYS, ALLOW_CLAUDE_EXECUTION: allow } });
      const r = await c.app.inject({ url: '/local/v1/capabilities', headers: { host: HOST } });
      const cap = Capabilities.parse(r.json());
      expect(cap.aiGeneration.available).toBe(false);
      expect(cap.aiGeneration.runner).not.toBe('claude-code');
      for (const v of Object.values(KEYS)) expect(r.payload).not.toContain(v);
    }
  });
  it('loadConfig does not copy billing env values into config', () => {
    const cfg = loadConfig({ ...KEYS, PERSONAL_OWNER_USER_ID: 'u1' });
    expect(JSON.stringify(cfg)).not.toMatch(/FAKE/);
  });
  const forbidden = { apiKey: 'sk-ant-LEAK1', anthropicApiKey: 'sk-ant-LEAK2', oauthToken: 'oat-LEAK3', model: 'claude-opus-LEAK', cliArgs: ['--dangerously-skip-permissions'], env: { ANTHROPIC_API_KEY: 'x' }, ownerId: 'u9' };
  for (const [k, v] of Object.entries(forbidden)) {
    it(`request body field "${k}" is rejected 422 and the runner is never called`, async () => {
      const { runner, calls } = runnerOf(async () => ok(envelope()));
      const c = make({ env: KEYS, app: { runner } });
      const { h } = await session(c);
      const r = await gen(c, h, 'key-12345678', { constraints, [k]: v });
      expect(r.statusCode).toBe(422);
      expect(codeOf(r)).toBe('VALIDATION_FAILED');
      expect(r.payload).not.toContain('LEAK');
      expect(calls).toHaveLength(0);
    });
  }
  it('same fields smuggled inside constraints are rejected or dropped before the runner', async () => {
    const { runner, calls } = runnerOf(async () => ok(envelope()));
    const c = make({ env: KEYS, app: { runner } });
    const { h } = await session(c);
    const r = await gen(c, h, 'key-12345678', { constraints: { ...constraints, apiKey: 'sk-ant-LEAK1', model: 'claude-opus-LEAK' } });
    if (r.statusCode === 202) {
      await settle(c, h, (r.json() as { jobId: string }).jobId);
      expect(JSON.stringify(calls.map(x => x.input))).not.toContain('LEAK');
    } else expect(r.statusCode).toBe(422);
  });
  it('GenerationInput given to the runner has no secret, cookie, csrf, or billing value', async () => {
    const { runner, calls } = runnerOf(async () => ok(envelope()));
    const c = make({ env: KEYS, app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const s = await session(c);
    await settle(c, s.h as never, await submit(c, s.h));
    expect(calls).toHaveLength(1);
    const dump = JSON.stringify(calls[0]!.input);
    for (const bad of [s.cookie, s.cookie.split('=')[1]!, s.csrf, UP_COOKIE, UP_CSRF, 'UPSTREAMSECRET', ...Object.values(KEYS), 'ANTHROPIC_', 'OAUTH']) {
      expect(dump).not.toContain(bad);
    }
    expect(Object.keys(calls[0]!.input).sort()).toEqual(['allowedPlaceIds', 'constraints', 'facts', 'fixedActivities', 'instructions', 'schemaVersion']);
  });
  it('shell metacharacters in user text stay data inside constraints', async () => {
    const { runner, calls } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const area = '$(id); `rm -rf /` --model opus';
    const r = await gen(c, h, 'key-12345678', { constraints: { ...constraints, area } });
    expect(r.statusCode).toBe(202);
    await settle(c, h, (r.json() as { jobId: string }).jobId);
    expect(calls[0]!.input.constraints.area).toBe(area);
    expect(calls[0]!.input.instructions).not.toContain(area);
  });
  it('upstream session cookie / csrf never appear in any personal-entry response', async () => {
    const c = make({ env: KEYS, app: { runner: runnerOf(async () => ok(envelope())).runner } });
    const s = await session(c);
    const id = await submit(c, s.h);
    for (const url of ['/local/v1/session', `/local/v1/jobs/${id}`, '/local/v1/capabilities', '/local/v1/health']) {
      const r = await c.app.inject({ url, headers: { host: HOST, ...s.h } });
      expect(r.payload + JSON.stringify(r.headers)).not.toMatch(/UPSTREAM/);
    }
  });
});

describe('public / shared entry refusal', () => {
  it('shared server has no generation, job or cancel routes and reports SHARED_ENTRY_NO_PERSONAL_CLAUDE', async () => {
    const app = buildShared({ config: { ...loadShared({}), databasePath: ':memory:' } });
    try {
      for (const [method, url] of [
        ['POST', '/api/v1/generations'], ['POST', '/local/v1/generations'], ['GET', '/local/v1/jobs/x'],
        ['POST', '/local/v1/jobs/x/cancel'], ['GET', '/api/v1/jobs/x'], ['POST', '/api/v1/jobs/x/cancel'], ['POST', '/local/v1/pair'],
      ] as const) {
        const r = await app.inject({ method, url, payload: method === 'POST' ? { constraints: {} } : undefined });
        expect(r.statusCode, `${method} ${url}`).toBe(404);
      }
      const c = Capabilities.parse((await app.inject('/api/v1/capabilities')).json());
      expect(c.aiGeneration).toEqual({ available: false, runner: 'none', reason: 'SHARED_ENTRY_NO_PERSONAL_CLAUDE' });
    } finally { await app.close(); }
  });
  it('personal app rejects non-loopback Host (tunnel hostname) on every route', async () => {
    const c = make();
    for (const host of ['evil.example', 'xxxx.trycloudflare.com', '127.0.0.1', '127.0.0.1:9999', '0.0.0.0:4311', '192.168.1.5:4311', '']) {
      const r = await c.app.inject({ url: '/local/v1/health', headers: { host } });
      expect(r.statusCode, host).toBe(403);
    }
  });
  it('tunnel-like forwarded headers cannot stand in for a loopback Host', async () => {
    const c = make();
    const r = await c.app.inject({
      url: '/local/v1/health',
      headers: { host: 'abc.ngrok.app', 'x-forwarded-host': HOST, 'x-forwarded-for': '127.0.0.1', 'x-forwarded-proto': 'http', forwarded: `for=127.0.0.1;host=${HOST}` },
    });
    expect(r.statusCode).toBe(403);
    const w = await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: c.pairing.issue() }, remoteAddress: '203.0.113.9', headers: { host: 'abc.ngrok.app', origin: 'https://abc.ngrok.app', 'x-forwarded-host': HOST } });
    expect(w.statusCode).toBe(403);
  });
  it('loopback Host does not make a forwarded foreign client privileged: state changes still need pairing', async () => {
    const c = make();
    const r = await post(c, '/local/v1/generations', { constraints }, { 'x-forwarded-for': '203.0.113.9', 'idempotency-key': 'key-12345678' });
    expect(r.statusCode).toBe(401);
  });
  it('foreign / tunnel Origin is refused for reads and writes; opaque and missing Origin on POST need same-origin', async () => {
    const c = make();
    for (const origin of ['https://evil.example', 'http://127.0.0.1.evil.example', 'null', 'http://127.0.0.1:4312']) {
      expect((await c.app.inject({ url: '/local/v1/health', headers: { host: HOST, origin } })).statusCode, origin).toBe(403);
      const p = await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: c.pairing.issue() }, headers: { host: HOST, origin } });
      expect(p.statusCode, origin).toBe(403);
    }
    const noOrigin = await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: c.pairing.issue() }, headers: { host: HOST } });
    expect(noOrigin.statusCode).toBe(403);
    const cross = await c.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: 'x' }, headers: { host: HOST, 'sec-fetch-site': 'cross-site' } });
    expect(cross.statusCode).toBe(403);
    // sanity: the legitimate origin works
    expect((await c.app.inject({ url: '/local/v1/health', headers: { host: HOST, origin: ORIGIN } })).statusCode).toBe(200);
  });
  it('no CORS headers are ever emitted', async () => {
    const c = make();
    const r = await c.app.inject({ url: '/local/v1/health', headers: { host: HOST, origin: ORIGIN } });
    expect(Object.keys(r.headers).filter(k => k.startsWith('access-control-'))).toEqual([]);
    const o = await c.app.inject({ method: 'OPTIONS', url: '/local/v1/generations', headers: { host: HOST, origin: ORIGIN, 'access-control-request-method': 'POST' } });
    expect(Object.keys(o.headers).filter(k => k.startsWith('access-control-'))).toEqual([]);
  });
  it('config refuses non-loopback bind, replaced env, and invalid limits', () => {
    for (const b of ['0.0.0.0', '::', '192.168.0.2', 'example.com', '127.0.0.2', ' 127.0.0.1']) {
      expect(() => loadConfig({ PERSONAL_BIND: b }), b).toThrow(/loopback/);
    }
    for (const b of ['127.0.0.1', '::1', 'localhost']) expect(loadConfig({ PERSONAL_BIND: b }).bind).toBe(b);
    expect(() => loadConfig({ PERSONAL_ALLOWED_USER_IDS: 'a,b' })).toThrow();
    expect(() => loadConfig({ PERSONAL_OWNER_USER_ID: 'a,b' })).toThrow();
    expect(() => loadConfig({ AI_QUEUE_LIMIT: '0' })).toThrow();
    expect(() => loadConfig({ AI_TIMEOUT_SECONDS: '-1' })).toThrow();
  });
  it('without an owner configured nobody can log in (deny all)', async () => {
    const c = make({ owner: '', app: { fetch: loginFetch('u1') } });
    const r = await post(c, '/local/v1/pair', { code: c.pairing.issue() });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const l = await post(c, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, { cookie, 'x-csrf-token': (r.json() as { csrfToken: string }).csrfToken });
    expect(l.statusCode).toBe(403);
  });
});
