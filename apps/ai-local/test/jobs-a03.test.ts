import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type GenerationInput, type JobStage, type JobState } from '@tkb/contracts';
import { FakeRunner, type Runner } from '@tkb/ai';
import { buildApp } from '../src/app.ts';
import { PairingStore } from '../src/auth/pairing.ts';
import { loadConfig } from '../src/config.ts';
import { FileJobStore, JobManager, MemoryJobStore, transition } from '../src/jobs/index.ts';
import { operationKeyOf } from '../src/jobs/index.ts';

import { samplePlanBlueprint } from '@tkb/fixtures';
const placeIds = samplePlanBlueprint.candidates.flatMap(c => c.activityOrder);
const SENTINEL = 'SENTINEL-AREA-ZZZ';
const input: GenerationInput = {
  schemaVersion: SCHEMA_VERSION,
  constraints: { area: SENTINEL, startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
  allowedPlaceIds: [],
  facts: [],
  fixedActivities: [],
  instructions: 'x',
};
const never: Runner = { run: () => new Promise(() => {}) };
const until = async (f: () => boolean) => {
  for (let i = 0; i < 300 && !f(); i++) await new Promise(r => setTimeout(r, 10));
  expect(f()).toBe(true);
};
const accept = (r: { kind: string; jobId?: string }) => {
  if (r.kind !== 'accepted') throw new Error(r.kind);
  return r.jobId!;
};
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'a03-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mk = (o: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) =>
  new JobManager({ runner: never, queueLimit: 8, timeoutMs: 60_000, ...o });

describe('transition()', () => {
  const p = (state: JobState, stage: JobStage) => ({ state, stage });
  it('allows the legal moves', () => {
    expect(transition(p('queued', 'queued'), p('running', 'collecting_context'))).toEqual(p('running', 'collecting_context'));
    expect(transition(p('running', 'collecting_context'), p('running', 'generating')).stage).toBe('generating');
    expect(transition(p('running', 'saved'), p('succeeded', 'done')).state).toBe('succeeded');
    expect(transition(p('queued', 'queued'), p('cancelled', 'queued')).state).toBe('cancelled');
    expect(transition(p('queued', 'queued'), p('failed', 'queued')).state).toBe('failed');
    expect(transition(p('running', 'generating'), p('failed', 'generating')).state).toBe('failed');
  });
  it('rejects illegal moves', () => {
    for (const t of ['succeeded', 'failed', 'cancelled'] as const) {
      for (const to of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
        expect(() => transition(p(t, 'done'), p(to, 'done'))).toThrow();
      }
    }
    expect(() => transition(p('queued', 'queued'), p('succeeded', 'done'))).toThrow();
    expect(() => transition(p('running', 'generating'), p('queued', 'generating'))).toThrow();
    expect(() => transition(p('running', 'validating'), p('running', 'generating'))).toThrow(); // regression
    expect(() => transition(p('running', 'validating'), p('running', 'validating'))).toThrow(); // no-op advance
    expect(() => transition(p('running', 'generating'), p('succeeded', 'saved'))).toThrow(); // needs done
  });
});

describe('restart handling', () => {
  it('running/queued jobs become failed WORKER_RESTARTED (retryable) after a crash; journal has no constraints', async () => {
    const dir = tmp();
    const m1 = mk({ store: new FileJobStore(dir) });
    const a = accept(m1.submit('u1', 'key-00000001', 'f1', input)); // running
    const b = accept(m1.submit('u1', 'key-00000002', 'f2', input)); // queued
    expect(m1.status('u1', a)?.state).toBe('running');
    // "crash": a new manager on the same dir
    const m2 = mk({ store: new FileJobStore(dir) });
    await m2.ready;
    for (const id of [a, b]) {
      const s = m2.status('u1', id)!;
      expect(s.state).toBe('failed');
      expect(s.error?.code).toBe('WORKER_RESTARTED');
      expect(s.error?.retryable).toBe(true);
    }
    expect(m2.status('u2', a)).toBeNull();
    // the failure itself is persisted
    const m3 = mk({ store: new FileJobStore(dir) });
    await m3.ready;
    expect(m3.status('u1', a)?.error?.code).toBe('WORKER_RESTARTED');
    // journal content: metadata only
    const files = readdirSync(join(dir, 'jobs'));
    expect(files.length).toBe(2);
    expect(files.some(f => f.endsWith('.tmp'))).toBe(false);
    for (const f of files) {
      const txt = readFileSync(join(dir, 'jobs', f), 'utf8');
      expect(txt).not.toContain(SENTINEL);
      expect(txt).not.toContain('key-0000000');
      expect(txt).not.toContain('constraints');
      expect(Object.keys(JSON.parse(txt)).sort()).toEqual(
        ['batchId', 'error', 'fingerprint', 'idemHash', 'jobId', 'operationKey', 'ownerId', 'stage', 'state', 'updatedAt'],
      );
    }
  });
  it('findSavedBatch hit turns a running job into succeeded with the batchId', async () => {
    const store = new MemoryJobStore();
    const m1 = mk({ store });
    const a = accept(m1.submit('u1', 'key-00000001', 'f1', input));
    const asked: [string, string][] = [];
    const m2 = mk({ store, findSavedBatch: async (o, k) => (asked.push([o, k]), 'b-123') });
    await m2.ready;
    const s = m2.status('u1', a)!;
    expect(s.state).toBe('succeeded');
    expect(s.stage).toBe('done');
    expect(s.batchId).toBe('b-123');
    expect(asked).toEqual([['u1', operationKeyOf('u1', 'key-00000001')]]);
  });
  it('findSavedBatch failure falls back to WORKER_RESTARTED', async () => {
    const store = new MemoryJobStore();
    const a = accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const m2 = mk({ store, findSavedBatch: async () => { throw new Error('down'); } });
    await m2.ready;
    expect(m2.status('u1', a)?.error?.code).toBe('WORKER_RESTARTED');
  });
  it('idempotency survives restart: same key+fingerprint returns the existing (settled) job, other fingerprint conflicts', async () => {
    const store = new MemoryJobStore();
    const a = accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const m2 = mk({ store, findSavedBatch: async () => 'b-1' });
    await m2.ready;
    expect(accept(m2.submit('u1', 'key-00000001', 'f1', input))).toBe(a);
    expect(m2.submit('u1', 'key-00000001', 'zzz', input).kind).toBe('conflict');
    expect(m2.status('u1', a)?.state).toBe('succeeded');
    expect(accept(m2.submit('u2', 'key-00000001', 'f1', input))).not.toBe(a);
  });
  it('resubmit of a WORKER_RESTARTED job starts a new attempt with the same operationKey, consulting findSavedBatch first', async () => {
    const store = new MemoryJobStore();
    const a = accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const asked: string[] = [];
    let found: string | null = null;
    const m2 = mk({ store, findSavedBatch: async (_o, k) => (asked.push(k), found) });
    await m2.ready;
    expect(m2.status('u1', a)?.error?.code).toBe('WORKER_RESTARTED');
    found = 'late-batch'; // the earlier save committed after all
    const b = accept(m2.submit('u1', 'key-00000001', 'f1', input));
    expect(b).not.toBe(a);
    await until(() => m2.status('u1', b)?.state === 'succeeded');
    expect(m2.status('u1', b)?.batchId).toBe('late-batch');
    expect(new Set(asked)).toEqual(new Set([operationKeyOf('u1', 'key-00000001')]));
    expect(accept(m2.submit('u1', 'key-00000001', 'f1', input))).toBe(b); // now settled: idempotent
  });
  it('resubmit with no saved batch runs the runner again (same operationKey passed to save)', async () => {
    const store = new MemoryJobStore();
    accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const keys: string[] = [];
    const m2 = mk({ store, runner: new FakeRunner(), allowedPlaceIds: placeIds, save: async c => (keys.push(c.operationKey), { batchId: 'nb' }) });
    await m2.ready;
    const b = accept(m2.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m2.status('u1', b)?.state === 'succeeded');
    expect(keys).toEqual([operationKeyOf('u1', 'key-00000001')]);
  });
  it('reviewer repro: save pending at crash, restart, findSavedBatch -> b => succeeded with batchId b', async () => {
    const dir = tmp();
    const m1 = mk({ store: new FileJobStore(dir), runner: new FakeRunner(), allowedPlaceIds: placeIds, save: () => new Promise(() => {}) });
    const a = accept(m1.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m1.status('u1', a)?.stage === 'saving');
    const m2 = mk({ store: new FileJobStore(dir), findSavedBatch: async () => 'b' });
    await m2.ready;
    expect(m2.status('u1', a)).toMatchObject({ state: 'succeeded', stage: 'done', batchId: 'b' });
    const m3 = mk({ store: new FileJobStore(dir) });
    await m3.ready;
    expect(m3.status('u1', a)).toMatchObject({ state: 'succeeded', batchId: 'b' });
  });
  it('queued jobs are checked too', async () => {
    const store = new MemoryJobStore();
    const m1 = mk({ store });
    accept(m1.submit('u1', 'key-00000001', 'f1', input));
    const q = accept(m1.submit('u1', 'key-00000002', 'f2', input));
    const m2 = mk({ store, findSavedBatch: async () => 'bq' });
    await m2.ready;
    expect(m2.status('u1', q)).toMatchObject({ state: 'succeeded', batchId: 'bq' });
  });
  it('findSavedBatch error: failed in memory only, journal stays non-terminal and is re-checked on the next start', async () => {
    const dir = tmp();
    const a = accept(mk({ store: new FileJobStore(dir) }).submit('u1', 'key-00000001', 'f1', input));
    const m2 = mk({ store: new FileJobStore(dir), findSavedBatch: async () => { throw new Error('down'); } });
    await m2.ready;
    expect(m2.status('u1', a)?.error).toMatchObject({ code: 'WORKER_RESTARTED', retryable: true });
    const rec = JSON.parse(readFileSync(join(dir, 'jobs', `${a}.json`), 'utf8')) as { state: string };
    expect(rec.state).toBe('running');
    const m3 = mk({ store: new FileJobStore(dir), findSavedBatch: async () => 'b-later' });
    await m3.ready;
    expect(m3.status('u1', a)).toMatchObject({ state: 'succeeded', batchId: 'b-later' });
  });
  it('eviction removes journal entries too', async () => {
    const dir = tmp();
    const m = mk({ store: new FileJobStore(dir), runner: new FakeRunner({ failure: 'exit_nonzero' }), maxFinished: 2, tombstoneLimit: 0 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(accept(m.submit('u1', `key-0000000${i}`, `f${i}`, input)));
      await until(() => m.status('u1', ids[i]!)?.state === 'failed');
    }
    expect(readdirSync(join(dir, 'jobs')).sort()).toEqual([`${ids[2]}.json`, `${ids[3]}.json`].sort());
    const m2 = mk({ store: new FileJobStore(dir), maxFinished: 2, tombstoneLimit: 0 });
    await m2.ready;
    expect(m2.status('u1', ids[0]!)).toBeNull();
    expect(m2.status('u1', ids[3]!)?.state).toBe('failed');
  });
});

describe('operationKey', () => {
  it('is deterministic per owner+key', () => {
    expect(operationKeyOf('u1', 'k')).toBe(operationKeyOf('u1', 'k'));
    expect(operationKeyOf('u1', 'k')).not.toBe(operationKeyOf('u2', 'k'));
    expect(operationKeyOf('u1', 'k')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('double submit', () => {
  it('concurrent identical submits make one job and one runner call', async () => {
    let calls = 0;
    const runner: Runner = { run: async () => (calls++, { exitCode: 1, envelope: null, durationMs: 1, error: undefined }) };
    const m = mk({ runner });
    const ids = await Promise.all([1, 2, 3, 4, 5].map(async () => accept(m.submit('u1', 'key-00000001', 'f1', input))));
    expect(new Set(ids).size).toBe(1);
    await until(() => m.status('u1', ids[0]!)?.state === 'failed');
    expect(calls).toBe(1);
  });
});

describe('cancel (K21)', () => {
  it('queued and running become cancelled, terminal is unchanged', async () => {
    const m = mk();
    const a = accept(m.submit('u1', 'key-00000001', 'f1', input));
    const b = accept(m.submit('u1', 'key-00000002', 'f2', input));
    expect(m.cancel('u1', b)).toMatchObject({ state: 'cancelled', wasActive: true, committed: false, batchId: null });
    expect(m.cancel('u1', a)).toMatchObject({ state: 'cancelled', wasActive: true });
    expect(m.cancel('u1', a)).toMatchObject({ state: 'cancelled', wasActive: false, committed: false });
    expect(m.cancel('u2', a)).toBeNull();
  });
  it('from saving onward cancel is refused as committed and reports the batch', async () => {
    let release!: (v: { batchId: string }) => void;
    const saved = new Promise<{ batchId: string }>(r => (release = r));
    const m = mk({ runner: new FakeRunner(), save: () => saved, allowedPlaceIds: placeIds });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', id)?.stage === 'saving');
    expect(m.cancel('u1', id)).toMatchObject({ state: 'running', wasActive: false, committed: true });
    release({ batchId: 'batch-1' });
    await until(() => m.status('u1', id)?.state === 'succeeded');
    expect(m.status('u1', id)?.batchId).toBe('batch-1');
    expect(m.cancel('u1', id)).toMatchObject({ state: 'succeeded', batchId: 'batch-1', committed: false, wasActive: false });
  });
  it('cancelled while the runner is busy never reaches the saver, even if the runner then finishes', async () => {
    let saves = 0;
    let finish!: () => void;
    const inner = new FakeRunner();
    const slow: Runner = { run: async (i, s) => { await new Promise<void>(r => (finish = r)); return inner.run(i, s); } };
    const m = mk({ runner: slow, allowedPlaceIds: placeIds, save: async () => (saves++, { batchId: 'x' }) });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => !!finish);
    m.cancel('u1', id);
    finish();
    await new Promise(r => setTimeout(r, 50));
    expect(saves).toBe(0);
    expect(m.status('u1', id)?.state).toBe('cancelled');
  });
  it('B1: a failed journal write for stage saving fails the job and the saver is NOT called', async () => {
    let saves = 0;
    const store = new MemoryJobStore();
    const orig = store.save.bind(store);
    store.save = rec => {
      if (rec.stage === 'saving') throw new Error('disk full');
      orig(rec);
    };
    const m = mk({ store, runner: new FakeRunner(), allowedPlaceIds: placeIds, save: async () => (saves++, { batchId: 'x' }) });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', id)?.state === 'failed');
    expect(m.status('u1', id)?.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(saves).toBe(0);
  });
  it('O1: deadline does not abort a save in progress; save errors map to UNAVAILABLE', async () => {
    let release!: (v: { batchId: string }) => void;
    const m = mk({ timeoutMs: 40, runner: new FakeRunner(), allowedPlaceIds: placeIds, save: () => new Promise(r => (release = r)) });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => !!release);
    await new Promise(r => setTimeout(r, 80)); // past the deadline
    expect(m.status('u1', id)?.state).toBe('running');
    release({ batchId: 'late' });
    await until(() => m.status('u1', id)?.state === 'succeeded');
    const m2 = mk({ runner: new FakeRunner(), allowedPlaceIds: placeIds, save: async () => { throw new Error('boom'); } });
    const id2 = accept(m2.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m2.status('u1', id2)?.state === 'failed');
    expect(m2.status('u1', id2)?.error).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
  });
  it('O1: save timeout consults findSavedBatch (hit => succeeded, miss => UNAVAILABLE, then resubmit is a new attempt)', async () => {
    let found: string | null = 'tb';
    const mkm = () => mk({ saveTimeoutMs: 30, runner: new FakeRunner(), allowedPlaceIds: placeIds, save: () => new Promise(() => {}), findSavedBatch: async () => found });
    const m = mkm();
    const a = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', a)?.state === 'succeeded');
    expect(m.status('u1', a)?.batchId).toBe('tb');
    found = null;
    const b = accept(m.submit('u1', 'key-00000002', 'f2', input));
    await until(() => m.status('u1', b)?.state === 'failed');
    expect(m.status('u1', b)?.error?.code).toBe('UNAVAILABLE');
    expect(accept(m.submit('u1', 'key-00000002', 'f2', input))).not.toBe(b);
  });
  it('O4: an invalid batchId from the saver is not trusted', async () => {
    const m = mk({ runner: new FakeRunner(), allowedPlaceIds: placeIds, save: async () => ({ batchId: 'bad id!' }) });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', id)?.state === 'failed');
    expect(m.status('u1', id)?.error?.code).toBe('UNAVAILABLE');
    expect(m.status('u1', id)?.batchId).toBeNull();
  });
  it('without a saver, valid output fails UNAVAILABLE and never succeeds', async () => {
    const m = mk({ runner: new FakeRunner() });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => ['failed', 'succeeded'].includes(m.status('u1', id)!.state));
    expect(m.status('u1', id)?.state).toBe('failed');
  });
});

describe('HTTP mapping', () => {
  const HOST = '127.0.0.1:4311';
  const ORIGIN = 'http://127.0.0.1:4311';
  const constraints = input.constraints;
  const upstream = async () => {
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', 'tkb_sid=S; HttpOnly; Path=/');
    return new Response(JSON.stringify({ userId: 'u1', displayName: 'T', csrfToken: 'C' }), { status: 200, headers: h });
  };
  async function start(save?: ConstructorParameters<typeof JobManager>[0]['save']) {
    const config = loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' });
    const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
    const app = buildApp({ config, pairing, runner: new FakeRunner(), fetch: upstream, allowedPlaceIds: placeIds, save });
    const p = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
    const h = { host: HOST, origin: ORIGIN, cookie: String(p.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (p.json() as { csrfToken: string }).csrfToken };
    await app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: h });
    return { app, h };
  }
  it('cancel after the saving stage is 409 ALREADY_COMMITTED and does not cancel', async () => {
    let release!: (v: { batchId: string }) => void;
    const { app, h } = await start(() => new Promise(r => (release = r)));
    const g = await app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': 'key-12345678' } });
    const { jobId } = g.json() as { jobId: string };
    await until(() => !!release);
    const c = await app.inject({ method: 'POST', url: `/local/v1/jobs/${jobId}/cancel`, headers: h });
    expect(c.statusCode).toBe(409);
    expect((c.json() as { code: string }).code).toBe('ALREADY_COMMITTED');
    expect((c.json() as { details?: { batchId?: string } }).details?.batchId).toBeUndefined(); // batch not known yet
    release({ batchId: 'b1' });
    for (let i = 0; i < 100; i++) {
      const s = (await app.inject({ url: `/local/v1/jobs/${jobId}`, headers: { host: HOST, cookie: h.cookie } })).json() as { state: string; batchId: string | null };
      if (s.state === 'succeeded') return expect(s.batchId).toBe('b1');
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('never succeeded');
  });
  it('another user cannot see a recovered job after restart (404)', async () => {
    const dir = tmp();
    const mkApp = (uid: string) => {
      const config = { ...loadConfig({ PERSONAL_OWNER_USER_ID: uid }), jobDir: dir };
      const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
      const f = async () => {
        const h = new Headers({ 'content-type': 'application/json' });
        h.append('set-cookie', 'tkb_sid=S; HttpOnly; Path=/');
        return new Response(JSON.stringify({ userId: uid, displayName: 'T', csrfToken: 'C' }), { status: 200, headers: h });
      };
      return { pairing, app: buildApp({ config, pairing, runner: never, fetch: f }) };
    };
    const login = async (x: ReturnType<typeof mkApp>) => {
      const p = await x.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: x.pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
      const h = { host: HOST, origin: ORIGIN, cookie: String(p.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (p.json() as { csrfToken: string }).csrfToken };
      await x.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: h });
      return h;
    };
    const a1 = mkApp('u1');
    const h1 = await login(a1);
    const g = await a1.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h1, 'idempotency-key': 'key-12345678' } });
    const { jobId } = g.json() as { jobId: string };
    const a2 = mkApp('u2');
    const h2 = await login(a2);
    expect((await a2.app.inject({ url: `/local/v1/jobs/${jobId}`, headers: { host: HOST, cookie: h2.cookie } })).statusCode).toBe(404);
    expect((await a2.app.inject({ method: 'POST', url: `/local/v1/jobs/${jobId}/cancel`, headers: h2 })).statusCode).toBe(404);
    await a1.app.close();
    await a2.app.close();
  });
  it('parallel HTTP double submit yields one job and one runner call', async () => {
    let calls = 0;
    const config = loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' });
    const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
    const runner: Runner = { run: async () => (calls++, { exitCode: 1, envelope: null, durationMs: 1, error: undefined }) };
    const app = buildApp({ config, pairing, runner, fetch: upstream, pipeline: false });
    const p = await app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
    const h = { host: HOST, origin: ORIGIN, cookie: String(p.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (p.json() as { csrfToken: string }).csrfToken };
    await app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: h });
    const rs = await Promise.all([1, 2, 3, 4].map(() => app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h, 'idempotency-key': 'key-12345678' } })));
    expect(new Set(rs.map(r => (r.json() as { jobId: string }).jobId)).size).toBe(1);
    expect(rs.every(r => r.statusCode === 202)).toBe(true);
    await new Promise(r => setTimeout(r, 50));
    expect(calls).toBe(1);
  });
  it('restart through buildApp + onReady: second app on the same jobDir recovers (found batch => succeeded)', async () => {
    const dir = tmp();
    let release!: (v: { batchId: string }) => void;
    const mkApp = (o: { save?: ConstructorParameters<typeof JobManager>[0]['save']; find?: () => Promise<string | null> }) => {
      const config = { ...loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' }), jobDir: dir };
      const pairing = new PairingStore({ ttlMs: config.pairingTtlMs });
      return { pairing, app: buildApp({ config, pairing, runner: new FakeRunner(), fetch: upstream, allowedPlaceIds: placeIds, save: o.save, findSavedBatch: o.find }) };
    };
    const login = async (x: ReturnType<typeof mkApp>) => {
      const p = await x.app.inject({ method: 'POST', url: '/local/v1/pair', payload: { code: x.pairing.issue() }, headers: { host: HOST, origin: ORIGIN } });
      const h = { host: HOST, origin: ORIGIN, cookie: String(p.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': (p.json() as { csrfToken: string }).csrfToken };
      await x.app.inject({ method: 'POST', url: '/local/v1/auth/login', payload: { loginId: 'a', password: 'b' }, headers: h });
      return h;
    };
    const a1 = mkApp({ save: () => new Promise(r => (release = r)) });
    const h1 = await login(a1);
    const g = await a1.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h1, 'idempotency-key': 'key-12345678' } });
    const { jobId } = g.json() as { jobId: string };
    await until(() => !!release);
    // "crash": a second app instance on the same dir
    const a2 = mkApp({ find: async () => 'recovered' });
    const h2 = await login(a2); // inject triggers onReady -> recovery done
    const s = await a2.app.inject({ url: `/local/v1/jobs/${jobId}`, headers: { host: HOST, cookie: h2.cookie } });
    expect(s.json()).toMatchObject({ state: 'succeeded', batchId: 'recovered' });
    const same = await a2.app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints }, headers: { ...h2, 'idempotency-key': 'key-12345678' } });
    expect((same.json() as { jobId: string }).jobId).toBe(jobId);
    await a1.app.close();
    await a2.app.close();
  });
  it('baseTripId / expectedRevision stay rejected (422) until A04 passes revisions through', async () => {
    const { app, h } = await start();
    for (const extra of [{ baseTripId: '00000000-0000-4000-8000-000000000000' }, { expectedRevision: 1 }]) {
      const r = await app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints, ...extra }, headers: { ...h, 'idempotency-key': 'key-12345678' } });
      expect(r.statusCode).toBe(422);
    }
  });
});

describe('M1 review', () => {
  it('cancel during the recoverCheck lookup is refused (409 path) and the late batch is still reachable', async () => {
    const store = new MemoryJobStore();
    accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    let found: string | null = null;
    let release!: () => void;
    const m = mk({ store, findSavedBatch: async () => (found === null ? null : (await new Promise<void>(r => (release = r)), found)) });
    await m.ready;
    found = 'late';
    const b = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => !!release);
    expect(m.cancel('u1', b)).toMatchObject({ committed: true, wasActive: false, state: 'running' });
    release();
    await until(() => m.status('u1', b)?.state === 'succeeded');
    expect(m.status('u1', b)?.batchId).toBe('late');
  });
  it('a cancelled/failed recoverCheck attempt is retryable: resubmit re-runs the lookup', async () => {
    const store = new MemoryJobStore();
    accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    let found: string | null = null;
    const m = mk({ store, timeoutMs: 40, runner: never, findSavedBatch: async () => (found === null ? (await new Promise(r => setTimeout(r, 100)), null) : found) });
    await m.ready;
    const b = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', b)?.state === 'failed'); // deadline during the lookup
    found = 'late';
    const c = accept(m.submit('u1', 'key-00000001', 'f1', input));
    expect(c).not.toBe(b);
    await until(() => m.status('u1', c)?.state === 'succeeded');
    expect(m.status('u1', c)?.batchId).toBe('late');
  });
  it('runner error text is replaced by a fixed message', async () => {
    const leaky: Runner = { run: async () => ({ exitCode: 1, envelope: null, durationMs: 1, error: { code: 'CLI_EXIT', message: 'SECRET /home/x token=abc', retryable: true, requestId: 'r' } }) };
    const m = mk({ runner: leaky });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    await until(() => m.status('u1', id)?.state === 'failed');
    expect(JSON.stringify(m.status('u1', id))).not.toContain('SECRET');
  });
  it('evicted jobs stay as compact records: same-key resubmit returns the old result; the record count is bounded', async () => {
    const dir = tmp();
    const m = mk({ store: new FileJobStore(dir), runner: new FakeRunner({ failure: 'exit_nonzero' }), maxFinished: 1, tombstoneLimit: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(accept(m.submit('u1', `key-0000000${i}`, `f${i}`, input)));
      await until(() => m.status('u1', ids[i]!)?.state === 'failed');
    }
    expect(readdirSync(join(dir, 'jobs')).filter(f => f.endsWith('.json')).length).toBe(3); // 1 live + 2 tombstones
    expect(accept(m.submit('u1', 'key-00000003', 'f3', input))).toBe(ids[3]); // old result, no new run
    expect(m.status('u1', ids[3]!)?.state).toBe('failed');
    expect(m.status('u1', ids[0]!)).toBeNull(); // pruned
  });
  it('ready rejection does not leak as unhandled', async () => {
    const store = new MemoryJobStore();
    store.loadAll = () => { throw new Error('bad journal'); };
    const m = mk({ store });
    await expect(m.ready).rejects.toThrow();
  });
});

describe('R1/R2 lookups', () => {
  it('R1: deadline during the pre-generate lookup fails CLI_TIMEOUT and the queue drains', async () => {
    const store = new MemoryJobStore();
    accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const m = mk({ store, runner: never, timeoutMs: 40, findSavedBatch: async () => (await new Promise(r => setTimeout(r, 150)), null) });
    await m.ready;
    const b = accept(m.submit('u1', 'key-00000001', 'f1', input));
    const c = accept(m.submit('u1', 'key-00000002', 'f2', input));
    await until(() => m.status('u1', b)?.state === 'failed');
    expect(m.status('u1', b)?.error).toMatchObject({ code: 'CLI_TIMEOUT', retryable: true });
    await until(() => m.status('u1', c)?.state === 'failed');
  });
  it('R2: a hanging findSavedBatch cannot block recovery', async () => {
    const store = new MemoryJobStore();
    const a = accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const m = mk({ store, lookupTimeoutMs: 30, findSavedBatch: () => new Promise(() => {}) });
    await m.ready;
    expect(m.status('u1', a)?.error?.code).toBe('WORKER_RESTARTED');
  });
});

describe('config', () => {
  it('saveTimeoutMs from AI_SAVE_TIMEOUT_SECONDS (default 60s)', () => {
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' }).saveTimeoutMs).toBe(60_000);
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1', AI_SAVE_TIMEOUT_SECONDS: '5' }).saveTimeoutMs).toBe(5000);
  });
  it('AI_JOB_DIR is optional', () => {
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' }).jobDir).toBeNull();
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1', AI_JOB_DIR: '/x/y' }).jobDir).toBe('/x/y');
  });
});

describe('file journal hardening', () => {
  it('O3/O7: invalid records are quarantined, stale tmp removed, no crash; O5/O6 permissions and secret', async () => {
    const dir = tmp();
    const m1 = mk({ store: new FileJobStore(dir) });
    const a = accept(m1.submit('u1', 'key-00000001', 'f1', input));
    const jd = join(dir, 'jobs');
    writeFileSync(join(jd, 'bogus.json'), JSON.stringify({ jobId: 'bogus', ownerId: 'u1', state: 'weird' }));
    writeFileSync(join(jd, 'junk.json'), '{not json');
    writeFileSync(join(jd, `${a.slice(0, 8)}.json.123.tmp`), 'partial');
    const m2 = mk({ store: new FileJobStore(dir) });
    await m2.ready;
    expect(m2.status('u1', a)?.error?.code).toBe('WORKER_RESTARTED');
    const names = readdirSync(jd).sort();
    expect(names).toContain('bogus.json.corrupt');
    expect(names).toContain('junk.json.corrupt');
    expect(names.some(n => n.endsWith('.tmp'))).toBe(false);
    if (process.platform !== 'win32') { // POSIX mode bits are not meaningful on Windows
      expect(statSync(jd).mode & 0o777).toBe(0o700);
      expect(statSync(join(jd, `${a}.json`)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'secret')).mode & 0o777).toBe(0o600);
    }
    // fingerprint is an HMAC, not the plain input
    const rec = JSON.parse(readFileSync(join(jd, `${a}.json`), 'utf8')) as { fingerprint: string };
    expect(rec.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.fingerprint).not.toBe('f1');
  });
  it('the secret is stable across restarts (idempotency still matches)', async () => {
    const dir = tmp();
    const a = accept(mk({ store: new FileJobStore(dir) }).submit('u1', 'key-00000001', 'f1', input));
    const m2 = mk({ store: new FileJobStore(dir), findSavedBatch: async () => 'bb' });
    await m2.ready;
    expect(accept(m2.submit('u1', 'key-00000001', 'f1', input))).toBe(a);
  });
});
