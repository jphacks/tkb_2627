// A04 step 2: runner factory (W2), capabilities (K22), K07 client and findSavedBatch wiring. Never runs the real CLI.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ClaudeCodeRunner, FakeRunner, type PreflightResult } from '@tkb/ai';
import { Capabilities, SCHEMA_VERSION, type PlanBatchCreate } from '@tkb/contracts';
import { buildApp } from '../src/app.ts';
import { PairingStore } from '../src/auth/pairing.ts';
import { loadConfig, type PersonalConfig } from '../src/config.ts';
import { operationKeyOf } from '../src/jobs/index.ts';
import { createRunner } from '../src/runner-factory.ts';
import { createPlanBatchClient, type FetchLike, type UpstreamHolder } from '../src/shared-client/index.ts';

const OK: PreflightResult = { found: true, loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', reason: null };
const cfg = (env: NodeJS.ProcessEnv = {}): PersonalConfig => loadConfig({ PERSONAL_OWNER_USER_ID: 'u1', ...env });
const ON = { ALLOW_CLAUDE_EXECUTION: 'true', CLAUDE_TERMS_ACK: 'true' };

describe('createRunner matrix', () => {
  const cases: [string, NodeJS.ProcessEnv, PreflightResult, boolean, string | null, string][] = [
    ['all off', {}, OK, false, 'CLAUDE_EXECUTION_DISABLED', 'fake'],
    ['ack only', { CLAUDE_TERMS_ACK: 'true' }, OK, false, 'CLAUDE_EXECUTION_DISABLED', 'fake'],
    ['allow only', { ALLOW_CLAUDE_EXECUTION: 'true' }, OK, false, 'TERMS_NOT_CONFIRMED', 'fake'],
    ['no owner', { ...ON, PERSONAL_OWNER_USER_ID: '' }, OK, false, 'TERMS_NOT_CONFIRMED', 'fake'],
    ['both, cli missing', ON, { found: false, reason: 'CLI_NOT_FOUND' }, false, 'CLI_NOT_FOUND', 'fake'],
    ['both, not logged in', ON, { found: true, loggedIn: false, reason: 'CLI_NOT_AUTHENTICATED' }, false, 'CLI_NOT_AUTHENTICATED', 'fake'],
    ['both, ok', ON, OK, true, null, 'claude-code'],
  ];
  for (const [name, env, pf, available, reason, runner] of cases) {
    it(name, async () => {
      let called = 0;
      const c = await createRunner(cfg(env), { preflight: async () => { called++; return pf; } });
      expect(c.status()).toEqual({ available, runner, reason });
      expect(c.runner instanceof ClaudeCodeRunner).toBe(available);
      expect(c.runner instanceof FakeRunner).toBe(!available);
      // the preflight is not even attempted unless both flags and the owner are set
      expect(called).toBe(env.ALLOW_CLAUDE_EXECUTION === 'true' && env.CLAUDE_TERMS_ACK === 'true' && env.PERSONAL_OWNER_USER_ID !== '' ? 1 : 0);
    });
  }
  it('uses CLAUDE_BIN / CLAUDE_MODEL and an invalid bin degrades to CLI_NOT_FOUND', async () => {
    const seen: string[] = [];
    const c = await createRunner(cfg({ ...ON, CLAUDE_BIN: '/opt/claude' }), { preflight: async o => { seen.push(o.bin); return OK; } });
    expect(seen).toEqual(['/opt/claude']);
    expect(c.status().available).toBe(true);
    const bad = await createRunner(cfg({ ...ON, CLAUDE_BIN: 'cl aude' }), { preflight: async () => OK });
    expect(bad.status()).toEqual({ available: false, runner: 'fake', reason: 'CLI_NOT_FOUND' });
  });
  it('a later failing preflight makes the real runner refuse and capabilities unavailable', async () => {
    let t = 0;
    let pf = OK;
    const c = await createRunner(cfg(ON), { preflight: async () => pf, now: () => t });
    pf = { found: true, loggedIn: false, reason: 'CLI_NOT_AUTHENTICATED' };
    t = 61_000;
    const r = await c.runner.run({ schemaVersion: SCHEMA_VERSION, constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' }, allowedPlaceIds: [], facts: [], fixedActivities: [], instructions: 'x' }, new AbortController().signal);
    expect(r.error?.code).toBe('CLI_NOT_AUTHENTICATED');
    expect(c.status()).toMatchObject({ available: false, reason: 'CLI_NOT_AUTHENTICATED' });
  });
});

describe('capabilities refresh (B1)', () => {
  it('available flips to false via the capabilities endpoint after the TTL when the preflight turns bad; real runs use a fresh preflight', async () => {
    let t = 0;
    let pf: PreflightResult = OK;
    let n = 0;
    const app = buildApp({ config: cfg(ON), pairing: new PairingStore({ ttlMs: 1000 }), runnerDeps: { preflight: async () => { n++; return pf; }, now: () => t } });
    try {
      const get = async () => Capabilities.parse((await app.inject({ url: '/local/v1/capabilities', headers: { host: '127.0.0.1:4311' } })).json()).aiGeneration;
      expect(await get()).toEqual({ available: true, runner: 'claude-code', reason: null });
      pf = { found: true, loggedIn: false, reason: 'CLI_NOT_AUTHENTICATED' };
      t = 30_000;
      expect((await get()).available).toBe(true); // still within the TTL: cached
      expect(n).toBe(1);
      t = 61_000;
      expect(await get()).toEqual({ available: false, runner: 'claude-code', reason: 'CLI_NOT_AUTHENTICATED' });
      expect(n).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe('capabilities via buildApp', () => {
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => { while (apps.length) await apps.pop()!.close(); });
  const caps = async (env: NodeJS.ProcessEnv, pf: PreflightResult) => {
    const config = cfg(env);
    const app = buildApp({ config, pairing: new PairingStore({ ttlMs: 1000 }), runnerDeps: { preflight: async () => pf } });
    apps.push(app);
    const r = await app.inject({ url: '/local/v1/capabilities', headers: { host: '127.0.0.1:4311' } });
    return Capabilities.parse(r.json()).aiGeneration;
  };
  it('available + claude-code only with both flags, owner and ok preflight', async () => {
    expect(await caps(ON, OK)).toEqual({ available: true, runner: 'claude-code', reason: null });
    expect(await caps({}, OK)).toEqual({ available: false, runner: 'fake', reason: 'CLAUDE_EXECUTION_DISABLED' });
    expect(await caps({ ALLOW_CLAUDE_EXECUTION: 'true' }, OK)).toEqual({ available: false, runner: 'fake', reason: 'TERMS_NOT_CONFIRMED' });
    expect(await caps(ON, { found: false, reason: 'CLI_NOT_FOUND' })).toMatchObject({ available: false, reason: 'CLI_NOT_FOUND' });
    expect(await caps(ON, { found: true, reason: 'CLI_NOT_AUTHENTICATED' })).toMatchObject({ available: false, reason: 'CLI_NOT_AUTHENTICATED' });
  });
});

describe('plan batch client (K07)', () => {
  const body = { schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'gen_12345678', candidates: [], places: [] } as unknown as PlanBatchCreate;
  const holder = (): UpstreamHolder => ({ upstream: { userId: 'u1', displayName: 'T', cookie: 'tkb_sid=UP', csrfToken: 'UPCSRF' } });
  const mk = (res: () => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch: FetchLike = async (url, init) => { calls.push({ url, init }); return res(); };
    return { calls, client: createPlanBatchClient({ baseUrl: 'http://shared.test:4310/', fetch }) };
  };
  const json = (s: number, b: unknown) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

  it('save sends exactly content-type, upstream cookie and upstream csrf to the fixed path', async () => {
    const { calls, client } = mk(() => json(201, { batchId: 'b1', candidateIds: ['c1'], validationState: 'needs_review' }));
    expect(await client.savePlanBatch(holder(), body)).toEqual({ ok: true, batchId: 'b1' });
    expect(calls[0]!.url).toBe('http://shared.test:4310/api/v1/plan-batches');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.headers).toEqual({ 'content-type': 'application/json', cookie: 'tkb_sid=UP', 'x-csrf-token': 'UPCSRF' });
    expect(calls[0]!.init.redirect).toBe('manual');
  });
  it('save maps 200 replay, 409, 422, 401 (clears upstream), 500, network error', async () => {
    const out = async (r: () => Response, h = holder()) => ({ r: await mk(r).client.savePlanBatch(h, body), h });
    const created = { batchId: 'b1', candidateIds: ['c1'], validationState: 'valid' };
    expect((await out(() => json(200, created))).r).toEqual({ ok: true, batchId: 'b1' });
    expect((await out(() => json(409, { code: 'IDEMPOTENCY_CONFLICT', message: 'x', retryable: false, requestId: 'r' }))).r).toEqual({ ok: false, code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    expect((await out(() => json(422, { code: 'VALIDATION_FAILED', message: 'x', retryable: false, requestId: 'r' }))).r).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    const u = await out(() => json(401, {}));
    expect(u.r).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
    expect(u.h.upstream).toBeNull();
    expect((await out(() => json(500, {}))).r).toEqual({ ok: false, code: 'UNAVAILABLE', retryable: true });
    const down = createPlanBatchClient({ baseUrl: 'http://x', fetch: async () => { throw new Error('down'); } });
    expect(await down.savePlanBatch(holder(), body)).toEqual({ ok: false, code: 'UNAVAILABLE', retryable: true });
    expect(await down.savePlanBatch({ upstream: null }, body)).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });
  it('find: 200 -> batchId, 404 -> null, others throw, 401 clears upstream, GET carries only cookie + csrf', async () => {
    const m = mk(() => json(200, { batchId: 'b9' }));
    expect(await m.client.findPlanBatchByGenerationId(holder(), 'gen_12345678')).toBe('b9');
    expect(m.calls[0]!.url).toBe('http://shared.test:4310/api/v1/plan-batches?generationId=gen_12345678');
    expect(m.calls[0]!.init.method).toBe('GET');
    expect(m.calls[0]!.init.headers).toEqual({ cookie: 'tkb_sid=UP', 'x-csrf-token': 'UPCSRF' });
    expect(await mk(() => json(404, {})).client.findPlanBatchByGenerationId(holder(), 'g1')).toBeNull();
    await expect(mk(() => json(500, {})).client.findPlanBatchByGenerationId(holder(), 'g1')).rejects.toThrow();
    const h = holder();
    await expect(mk(() => json(401, {})).client.findPlanBatchByGenerationId(h, 'g1')).rejects.toThrow();
    expect(h.upstream).toBeNull();
    await expect(mk(() => json(200, {})).client.findPlanBatchByGenerationId(holder(), 'g1')).rejects.toThrow();
    await expect(mk(() => json(200, {})).client.findPlanBatchByGenerationId({ upstream: null }, 'g1')).rejects.toThrow();
    await expect(mk(() => json(200, {})).client.findPlanBatchByGenerationId(holder(), 'bad id&x=1')).rejects.toThrow();
  });
});

describe('findSavedBatch wiring through JobManager restart', () => {
  const dirs: string[] = [];
  const apps: ReturnType<typeof buildApp>[] = [];
  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });
  const HOST = '127.0.0.1:4311';
  const ORIGIN = 'http://127.0.0.1:4311';
  const constraints = { area: 'Kanazawa', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' };

  it('after a restart, a resubmit asks the shared server by generationId=operationKey and succeeds with the found batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a04w-'));
    dirs.push(dir);
    const calls: { url: string; headers: unknown }[] = [];
    const key = 'idem-key-12345';
    const opKey = operationKeyOf('u1', key);
    const fetch: FetchLike = async (url, init) => {
      if (url.endsWith('/auth/login')) {
        const h = new Headers({ 'content-type': 'application/json' });
        h.append('set-cookie', 'tkb_sid=UP; Path=/');
        return new Response(JSON.stringify({ userId: 'u1', displayName: 'T', csrfToken: 'UPCSRF' }), { status: 200, headers: h });
      }
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify({ batchId: 'batch_found' }), { status: 200 });
    };
    const start = () => {
      const config = { ...cfg(), jobDir: dir };
      const pairing = new PairingStore({ ttlMs: 60_000 });
      // a runner that never finishes: the job stays active in the journal, as if the process died mid-run
      const app = buildApp({ config, pairing, fetch, runner: { run: () => new Promise(() => {}) } });
      apps.push(app);
      return { app, pairing };
    };
    const session = async (s: ReturnType<typeof start>) => {
      const p = await s.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: s.pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
      const cookie = String(p.headers['set-cookie']).split(';')[0]!;
      const h = { host: HOST, origin: ORIGIN, cookie, 'x-csrf-token': (p.json() as { csrfToken: string }).csrfToken };
      const l = await s.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: h });
      expect(l.statusCode).toBe(200);
      return h;
    };
    const first = start();
    const h1 = await session(first);
    const sub = await first.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints, mode: 'generate' }, headers: { ...h1, 'idempotency-key': key } });
    expect(sub.statusCode).toBe(202);
    await first.app.close();
    apps.pop();
    calls.length = 0;

    const second = start(); // restart: no session yet -> startup recovery cannot look up (counts as lookupFailed, journal kept)
    const h2 = await session(second);
    const re = await second.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints, mode: 'generate' }, headers: { ...h2, 'idempotency-key': key } });
    expect([200, 202]).toContain(re.statusCode);
    const jobId = (re.json() as { jobId: string }).jobId;
    let st: { state: string; batchId?: string | null } = { state: '' };
    for (let i = 0; i < 100 && st.state !== 'succeeded'; i++) {
      await new Promise(r => setTimeout(r, 20));
      st = (await second.app.inject({ url: `/local/v1/jobs/${jobId}`, headers: h2 })).json();
    }
    expect(st.state).toBe('succeeded');
    expect(st.batchId).toBe('batch_found');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:4310/api/v1/plan-batches?generationId=${opKey}`);
    expect(calls[0]!.headers).toEqual({ cookie: 'tkb_sid=UP', 'x-csrf-token': 'UPCSRF' });
  });
});
