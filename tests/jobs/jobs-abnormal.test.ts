// T04-2..5: model stop/hang, limits, duplicates, cancel, through the personal entry (HTTP).
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError, CancelResult, JobStatus } from '@tkb/contracts';
import { FileJobStore, MemoryJobStore } from '../../apps/ai-local/src/jobs/index.ts';
import { cancel, closeAll, codeOf, envelope, gen, getJob, make, ok, post, runnerOf, session, settle, sleep, submit, until } from '../ai/harness.ts';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 't04-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  await closeAll();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const SECRET = 'sk-ant-FAKE-0123456789 /home/toshiki/.claude/.credentials.json Bearer abc.def';
const journal = (dir: string) => readdirSync(join(dir, 'jobs')).map(f => readFileSync(join(dir, 'jobs', f), 'utf8')).join('\n');
const hang = () => runnerOf(() => new Promise(() => {}));

describe('model stop / hang / crash', () => {
  it('runner rejecting with a secret-bearing Error fails CLI_EXIT and the secret never appears anywhere', async () => {
    const dir = tmp();
    const { runner } = runnerOf(async () => { throw new Error(SECRET); });
    const c = make({ app: { runner, jobStore: new FileJobStore(dir) } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const job = await settle(c, h, id);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('CLI_EXIT');
    const raw = (await getJob(c, h, id)).payload;
    for (const part of ['sk-ant-FAKE', '.credentials', 'Bearer', '/home/']) {
      expect(raw).not.toContain(part);
      expect(journal(dir)).not.toContain(part);
    }
    // error responses too
    const bad = await gen(c, h, 'bad key!', { constraints: 1 });
    expect(bad.payload).not.toContain('sk-ant');
  });
  it('runner returning a SafeError whose message holds a secret never reaches the response or journal', async () => {
    const dir = tmp();
    const { runner } = runnerOf(async () => ({ exitCode: 1, envelope: null, durationMs: 1, error: { code: 'CLI_EXIT', message: SECRET, retryable: true, requestId: 'x' } }));
    const c = make({ app: { runner, jobStore: new FileJobStore(dir) } });
    const { h } = await session(c);
    const id = await submit(c, h);
    await settle(c, h, id);
    expect((await getJob(c, h, id)).payload).not.toContain('sk-ant');
    expect(journal(dir)).not.toContain('sk-ant');
  });
  it('runner that never settles hits the overall deadline: failed CLI_TIMEOUT and the signal is aborted', async () => {
    const { runner, calls } = hang();
    const c = make({ config: { aiTimeoutMs: 80 }, app: { runner } });
    const { h } = await session(c);
    const job = await settle(c, h, await submit(c, h));
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('CLI_TIMEOUT');
    expect(job.error?.message).toBe('The generator timed out.');
    expect(calls[0]!.signal.aborted).toBe(true);
  });
  it('a hung job does not block the next job once timed out', async () => {
    let n = 0;
    const { runner } = runnerOf(() => (++n === 1 ? new Promise(() => {}) : Promise.resolve(ok(envelope()))));
    const c = make({ config: { aiTimeoutMs: 100 }, app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const { h } = await session(c);
    const a = await submit(c, h, 'key-aaaaaaaa');
    const b = await submit(c, h, 'key-bbbbbbbb');
    expect((await settle(c, h, a)).error?.code).toBe('CLI_TIMEOUT');
    expect((await settle(c, h, b)).state).toBe('succeeded');
  });
  it('a job queued behind a hung one also ends CLI_TIMEOUT and any runner invocation it got is aborted', async () => {
    const { runner, calls } = hang();
    const c = make({ config: { aiTimeoutMs: 100 }, app: { runner } });
    const { h } = await session(c);
    await submit(c, h, 'key-aaaaaaaa');
    const q = await submit(c, h, 'key-bbbbbbbb');
    const job = await settle(c, h, q);
    expect(job.error?.code).toBe('CLI_TIMEOUT');
    // Deadlines are per job from submit with one shared timeout, so B can never expire while A still occupies the
    // runner: A's deadline aborts A first, the pump then starts B a few ms before B's own deadline, and B is aborted.
    // So "the runner is never called for B" is not a property of the implementation; assert what is.
    expect(calls).toHaveLength(2);
    expect(calls.every(x => x.signal.aborted)).toBe(true);
  });
  it('save failure leaks nothing and is UNAVAILABLE', async () => {
    const { runner } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner, save: async () => { throw new Error(SECRET); } } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const job = await settle(c, h, id);
    expect(job.error?.code).toBe('UNAVAILABLE');
    expect((await getJob(c, h, id)).payload).not.toContain('sk-ant');
  });
});

describe('limits', () => {
  it('CLI_LIMIT fails once, runner called exactly once (no retry / fallback), resubmit with same key returns same job', async () => {
    const { runner, calls } = runnerOf(async () => ({
      exitCode: 1, envelope: envelope({ is_error: true, result: 'usage limit' }), durationMs: 1,
      error: { code: 'CLI_LIMIT', message: 'You have hit your 5-hour limit sk-ant-X', retryable: false, requestId: 'r' },
    }));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const job = await settle(c, h, id);
    expect(job.error?.code).toBe('CLI_LIMIT');
    expect(job.error?.message).toBe('Usage limit reached.');
    expect(calls).toHaveLength(1);
    const again = await gen(c, h);
    expect((again.json() as { jobId: string }).jobId).toBe(id);
    expect((await settle(c, h, id)).error?.code).toBe('CLI_LIMIT'); // terminal before the negative check
    await sleep(30); // a retry would start asynchronously
    expect(calls).toHaveLength(1);
  });
  it('queue full -> 429 QUEUE_FULL retryable, and capacity frees after cancel', async () => {
    const { runner } = hang();
    const c = make({ config: { aiQueueLimit: 2 }, app: { runner } });
    const { h } = await session(c);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push(await submit(c, h, `key-0000000${i}`)); // 1 running + 2 queued
    const full = await gen(c, h, 'key-00000009');
    expect(full.statusCode).toBe(429);
    expect(codeOf(full)).toBe('QUEUE_FULL');
    expect(ApiError.parse(full.json()).retryable).toBe(true);
    expect((await cancel(c, h, ids[2]!)).statusCode).toBe(202);
    expect((await gen(c, h, 'key-00000009')).statusCode).toBe(202);
  });
});

describe('duplicates', () => {
  it('parallel identical submits give one job and one runner call', async () => {
    const { runner, calls } = hang();
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const rs = await Promise.all(Array.from({ length: 8 }, () => gen(c, h, 'key-dupdupdup')));
    expect(new Set(rs.map(r => (r.json() as { jobId: string }).jobId)).size).toBe(1);
    expect(rs.every(r => r.statusCode === 202)).toBe(true);
    await sleep(50);
    expect(calls).toHaveLength(1);
  });
  it('same key, different body -> 409 IDEMPOTENCY_CONFLICT, no extra runner call', async () => {
    const { runner, calls } = hang();
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const first = await submit(c, h, 'key-conflict1');
    const r = await gen(c, h, 'key-conflict1', { constraints: { area: 'Osaka', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' } });
    expect(r.statusCode).toBe(409);
    expect(codeOf(r)).toBe('IDEMPOTENCY_CONFLICT');
    expect(JobStatus.parse((await getJob(c, h, first)).json()).state).toBe('running');
    await sleep(30);
    expect(calls).toHaveLength(1);
  });
  it('resubmit after completion returns the same job without a new runner call', async () => {
    const { runner, calls } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const { h } = await session(c);
    const id = await submit(c, h, 'key-complete1');
    expect((await settle(c, h, id)).state).toBe('succeeded');
    const r = await gen(c, h, 'key-complete1');
    expect((r.json() as { jobId: string }).jobId).toBe(id);
    expect((await settle(c, h, id)).state).toBe('succeeded');
    await sleep(30);
    expect(calls).toHaveLength(1);
  });
  it('invalid Idempotency-Key values are rejected 422 before any job', async () => {
    const { runner, calls } = hang();
    const c = make({ app: { runner } });
    const { h } = await session(c);
    for (const k of ['short', 'has space key', 'x'.repeat(129), '../etc/passwd']) expect((await gen(c, h, k)).statusCode).toBe(422);
    const noKey = await post(c, '/local/v1/generations', { constraints: {} }, h);
    expect(noKey.statusCode).toBe(422);
    expect(calls).toHaveLength(0);
  });
});

describe('cancel', () => {
  it('queued job: 202, cancelled, runner never invoked for it', async () => {
    const { runner, calls } = hang();
    const c = make({ app: { runner } });
    const { h } = await session(c);
    await submit(c, h, 'key-first0001');
    const q = await submit(c, h, 'key-second001');
    const r = await cancel(c, h, q);
    expect(r.statusCode).toBe(202);
    expect(CancelResult.parse(r.json())).toMatchObject({ jobId: q, state: 'cancelled' });
    expect(JobStatus.parse((await getJob(c, h, q)).json()).state).toBe('cancelled');
    await sleep(30);
    expect(calls).toHaveLength(1);
  });
  it('running job: runner observes AbortSignal, then the next queued job runs', async () => {
    let n = 0;
    const { runner, calls } = runnerOf((_i, s) =>
      ++n === 1 ? new Promise((_, rej) => s.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) : Promise.resolve(ok(envelope())));
    const c = make({ app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const { h } = await session(c);
    const a = await submit(c, h, 'key-aaaaaaaa');
    const b = await submit(c, h, 'key-bbbbbbbb');
    await until(() => calls.length === 1);
    const r = await cancel(c, h, a);
    expect(r.statusCode).toBe(202);
    // relies on cancel() aborting the controller synchronously before the HTTP response
    expect(calls[0]!.signal.aborted).toBe(true);
    const st = JobStatus.parse((await getJob(c, h, a)).json());
    expect(st.state).toBe('cancelled');
    expect(st.error).toBeNull();
    expect((await settle(c, h, b)).state).toBe('succeeded');
    // a cancelled job is never resurrected by the runner settling later
    expect(JobStatus.parse((await getJob(c, h, a)).json()).state).toBe('cancelled');
  });
  it('running job whose runner ignores the signal is still cancelled and does not block the queue', async () => {
    let n = 0;
    const { runner } = runnerOf(() => (++n === 1 ? new Promise(() => {}) : Promise.resolve(ok(envelope()))));
    const c = make({ app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const { h } = await session(c);
    const a = await submit(c, h, 'key-aaaaaaaa');
    const b = await submit(c, h, 'key-bbbbbbbb');
    await cancel(c, h, a);
    expect((await settle(c, h, b)).state).toBe('succeeded');
  });
  it('finished job: 200 and unchanged state (failed stays failed)', async () => {
    const { runner } = runnerOf(async () => ok({ type: 'result' }));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const id = await submit(c, h);
    expect((await settle(c, h, id)).state).toBe('failed');
    const r = await cancel(c, h, id);
    expect(r.statusCode).toBe(200);
    expect(CancelResult.parse(r.json()).state).toBe('failed');
    expect((await cancel(c, h, id)).statusCode).toBe(200); // idempotent
  });
  it('unknown / malformed job id -> 404 NOT_FOUND', async () => {
    const c = make({ app: { runner: hang().runner } });
    const { h } = await session(c);
    for (const id of ['nope-nope', 'a'.repeat(100), '%2e%2e']) {
      expect((await cancel(c, h, id)).statusCode).toBe(404);
      expect((await getJob(c, h, id)).statusCode).toBe(404);
    }
  });
  it("another user's job (same journal, different owner) looks like an unknown one (404) and cannot be cancelled", async () => {
    const store = new MemoryJobStore();
    const c = make({ app: { runner: hang().runner, jobStore: store } });
    const { h } = await session(c);
    const id = await submit(c, h);
    // A second entry bound to another owner loads the same journal (restart recovery marks the job failed).
    const other = make({ owner: 'u2', app: { runner: hang().runner, jobStore: store } });
    await other.app.ready();
    const s2 = await session(other);
    expect((await getJob(other, s2.h, id)).statusCode).toBe(404);
    expect((await cancel(other, s2.h, id)).statusCode).toBe(404);
    expect(JobStatus.parse((await getJob(c, h, id)).json()).state).toBe('running');
  });
  it('unauthenticated / CSRF-less cancel is refused', async () => {
    const c = make({ app: { runner: hang().runner } });
    const { h, cookie } = await session(c);
    const id = await submit(c, h);
    expect((await post(c, `/local/v1/jobs/${id}/cancel`, undefined, { cookie })).statusCode).toBe(403);
    expect((await post(c, `/local/v1/jobs/${id}/cancel`, undefined)).statusCode).toBe(401);
    expect(JobStatus.parse((await getJob(c, h, id)).json()).state).toBe('running');
  });
  it('every status/cancel response parses as the contract schema through a full lifecycle', async () => {
    const { runner } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner, save: async () => ({ batchId: 'b-1' }) } });
    const { h } = await session(c);
    const id = await submit(c, h);
    const st = await settle(c, h, id);
    expect(st).toMatchObject({ state: 'succeeded', stage: 'done', batchId: 'b-1', error: null });
    expect((await cancel(c, h, id)).statusCode).toBe(200);
  });
});
