// T01 contract <-> implementation drift, personal entry (apps/ai-local, fake runner, no network, no CLI).
// Not repeated: job abnormal paths (tests/jobs), CLI boundary (tests/ai), spend/leak (tests/security).
import { afterEach, describe, expect, it } from 'vitest';
import { CancelResult, Capabilities, Health, JobAccepted, JobStatus, LoginResponse, SCHEMA_VERSION } from '@tkb/contracts';
import { HOST, cancel, closeAll, constraints, envelope, gen, getJob, make, ok, post, runnerOf, session, settle, submit } from '../ai/harness.ts';
import { expectErr, expectOk } from './helpers.ts';

afterEach(closeAll);
const save = async () => ({ batchId: 'batch_1' });
const good = () => runnerOf(async () => ok(envelope()));
const get = (c: ReturnType<typeof make>, url: string, headers: Record<string, string> = {}) => c.app.inject({ url, headers: { host: HOST, ...headers } });

describe('personal entry: success responses match the contract', () => {
  it('health and capabilities (K22) need no session; entry=personal, runner=fake, never available yet', async () => {
    const c = make();
    const h = expectOk('health', await get(c, '/local/v1/health'), 200, Health);
    expect(h.service).toBe('personal');
    expect(h.schemaVersion).toBe(SCHEMA_VERSION);
    const cap = expectOk('capabilities', await get(c, '/local/v1/capabilities'), 200, Capabilities);
    expect(cap).toMatchObject({ entry: 'personal', storage: 'shared-server', aiGeneration: { available: false, runner: 'fake', reason: 'CLAUDE_EXECUTION_DISABLED' } });
  });
  it('capabilities reason follows ALLOW_CLAUDE_EXECUTION but stays unavailable (A01 not confirmed)', async () => {
    const c = make({ env: { ALLOW_CLAUDE_EXECUTION: 'true' } });
    const cap = expectOk('capabilities', await get(c, '/local/v1/capabilities'), 200, Capabilities);
    expect(cap.aiGeneration).toEqual({ available: false, runner: 'fake', reason: 'TERMS_NOT_CONFIRMED' });
  });
  it('pair -> session -> login (K11) -> generations (K01) -> job (K02) -> cancel (K21)', async () => {
    const { runner } = good();
    const c = make({ app: { runner, save } });
    const pair = await post(c, '/local/v1/pair', { code: c.pairing.issue() });
    expect(pair.statusCode).toBe(200);
    const cookie = String(pair.headers['set-cookie']).split(';')[0]!;
    const csrf = (pair.json() as { csrfToken: string }).csrfToken;
    const h = { cookie, 'x-csrf-token': csrf };
    await expect(get(c, '/local/v1/session', { cookie }).then(r => r.json())).resolves.toEqual({ csrfToken: csrf, userId: null });
    const login = expectOk('login', await post(c, '/local/v1/auth/login', { loginId: 'a', password: 'b' }, h), 200, LoginResponse);
    expect(login.userId).toBe('u1');
    expect(login.csrfToken).toBe(csrf); // the local token, never the upstream one

    const accepted = expectOk('generations', await gen(c, h), 202, JobAccepted);
    const done = await settle(c, h, accepted.jobId);
    expect(done).toMatchObject({ state: 'succeeded', batchId: 'batch_1', error: null });
    // K02 docs example: a finished job reports stage "done"
    expect(done.stage).toBe('done');
    const after = expectOk('cancel after success', await cancel(c, h, accepted.jobId), 200, CancelResult);
    expect(after).toEqual({ jobId: accepted.jobId, state: 'succeeded', batchId: 'batch_1' });
    expectOk('job after cancel', await getJob(c, h, accepted.jobId), 200, JobStatus);
  });
  it('cancel of a running job is 202 with state cancelled and batchId null', async () => {
    const { runner } = runnerOf(() => new Promise(() => {}));
    const c = make({ app: { runner, save } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const r = expectOk('cancel running', await cancel(c, h, id), 202, CancelResult);
    expect(r).toEqual({ jobId: id, state: 'cancelled', batchId: null });
    expect((await settle(c, h, id)).state).toBe('cancelled');
  });
  it('a failed job is a JobStatus with a K23 error code, and cancelling it is 200', async () => {
    const { runner } = runnerOf(async () => ({ exitCode: 1, envelope: null, durationMs: 1, error: { code: 'CLI_EXIT', message: 'm', retryable: true, requestId: 'x' } }));
    const c = make({ app: { runner, save } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const j = await settle(c, h, id);
    expect(j.state).toBe('failed');
    expect(j.error?.code).toBe('CLI_EXIT');
    expectOk('cancel failed', await cancel(c, h, id), 200, CancelResult);
  });
});

describe('personal entry: every error is an ApiError with the K23 status', () => {
  it('table', async () => {
    const c = make({ app: { runner: runnerOf(async () => ok(envelope())).runner, save } });
    const { h } = await session(c);
    const fresh = make();
    const noLogin = await post(fresh, '/local/v1/pair', { code: fresh.pairing.issue() });
    const hp = { cookie: String(noLogin.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (noLogin.json() as { csrfToken: string }).csrfToken };
    const wrongHost = { host: 'evil.example' };
    const rows: [string, () => Promise<never>, Parameters<typeof expectErr>[2]][] = [
      ['wrong Host', () => c.app.inject({ url: '/local/v1/health', headers: wrongHost }) as never, 'FORBIDDEN'],
      ['foreign Origin', () => post(c, '/local/v1/generations', { constraints }, { ...h, origin: 'http://evil.example', 'idempotency-key': 'key-12345678' }) as never, 'FORBIDDEN'],
      ['no session on POST', () => post(c, '/local/v1/generations', { constraints }, { 'idempotency-key': 'key-12345678' }) as never, 'UNAUTHENTICATED'],
      ['no session on session', () => get(c, '/local/v1/session') as never, 'UNAUTHENTICATED'],
      ['no csrf', () => post(c, '/local/v1/generations', { constraints }, { cookie: h.cookie, 'idempotency-key': 'key-12345678' }) as never, 'FORBIDDEN'],
      ['pair with wrong code', () => (c.pairing.issue(), post(c, '/local/v1/pair', { code: 'nope' })) as never, 'FORBIDDEN'],
      ['pair without an issued code', () => post(fresh, '/local/v1/pair', { code: 'nope' }) as never, 'EXPIRED'],
      ['pair with extra key', () => post(c, '/local/v1/pair', { code: 'x', extra: 1 }) as never, 'VALIDATION_FAILED'],
      ['login body invalid', () => post(c, '/local/v1/auth/login', { loginId: '' }, h) as never, 'VALIDATION_FAILED'],
      ['generations before login', () => post(fresh, '/local/v1/generations', { constraints }, { ...hp, 'idempotency-key': 'key-12345678' }) as never, 'UNAUTHENTICATED'],
      ['jobs before login', () => get(fresh, '/local/v1/jobs/j1', hp) as never, 'UNAUTHENTICATED'],
      ['no Idempotency-Key', () => post(c, '/local/v1/generations', { constraints }, h) as never, 'VALIDATION_FAILED'],
      ['short Idempotency-Key', () => post(c, '/local/v1/generations', { constraints }, { ...h, 'idempotency-key': 'short' }) as never, 'VALIDATION_FAILED'],
      ['ownerId in body', () => gen(c, h, 'key-12345678', { constraints, ownerId: 'u2' }) as never, 'VALIDATION_FAILED'],
      ['impossible date', () => gen(c, h, 'key-12345678', { constraints: { ...constraints, startDate: '2026-02-30' } }) as never, 'VALIDATION_FAILED'],
      ['replan (not supported yet)', () => gen(c, h, 'key-12345678', { mode: 'replan', constraints, baseTripId: 't1', expectedRevision: 1 }) as never, 'VALIDATION_FAILED'],
      ['baseTripId (not supported yet)', () => gen(c, h, 'key-12345678', { constraints, baseTripId: 't1', expectedRevision: 1 }) as never, 'VALIDATION_FAILED'],
      ['unknown job', () => getJob(c, h, 'nope') as never, 'NOT_FOUND'],
      ['job id with illegal characters', () => getJob(c, h, 'a%20b') as never, 'NOT_FOUND'],
      ['cancel unknown job', () => cancel(c, h, 'nope') as never, 'NOT_FOUND'],
      ['unknown route', () => get(c, '/local/v1/nope', h) as never, 'NOT_FOUND'],
    ];
    for (const [label, run, code] of rows) expectErr(label, await run(), code);
  });
  it('same Idempotency-Key with a different body is 409 IDEMPOTENCY_CONFLICT; same body returns the same job', async () => {
    const c = make({ app: { runner: runnerOf(async () => ok(envelope())).runner, save } });
    const { h } = await session(c);
    const first = expectOk('first', await gen(c, h, 'key-aaaaaaaa'), 202, JobAccepted);
    const again = expectOk('same body', await gen(c, h, 'key-aaaaaaaa'), 202, JobAccepted);
    expect(again.jobId).toBe(first.jobId);
    expectErr('different body', await gen(c, h, 'key-aaaaaaaa', { constraints: { ...constraints, area: 'Other' } }), 'IDEMPOTENCY_CONFLICT');
  });
  it('queue overflow is 429 QUEUE_FULL and retryable', async () => {
    const c = make({ config: { aiQueueLimit: 1 }, app: { runner: runnerOf(() => new Promise(() => {})).runner, save } });
    const { h } = await session(c);
    await submit(c, h, 'key-aaaaaaaa'); // running
    await submit(c, h, 'key-bbbbbbbb'); // waiting (limit 1)
    const res = await gen(c, h, 'key-cccccccc');
    const e = expectErr('queue full', res, 'QUEUE_FULL');
    expect(e.retryable).toBe(true);
  });
  it('a state-changing request is never answered with a body that echoes the request', async () => {
    const c = make();
    const { h } = await session(c);
    const res = await post(c, '/local/v1/generations', { constraints: { area: 'SECRET-AREA-XYZ', startDate: 'bad' } }, { ...h, 'idempotency-key': 'key-12345678' });
    expectErr('invalid', res, 'VALIDATION_FAILED');
    expect(res.body).not.toContain('SECRET-AREA-XYZ');
  });
});
