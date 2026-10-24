import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  it('idempotency survives restart: same key+fingerprint returns the existing job, other fingerprint conflicts', async () => {
    const store = new MemoryJobStore();
    const a = accept(mk({ store }).submit('u1', 'key-00000001', 'f1', input));
    const m2 = mk({ store });
    await m2.ready;
    expect(accept(m2.submit('u1', 'key-00000001', 'f1', input))).toBe(a);
    expect(m2.submit('u1', 'key-00000001', 'zzz', input).kind).toBe('conflict');
    expect(m2.status('u1', a)?.state).toBe('failed');
    expect(accept(m2.submit('u2', 'key-00000001', 'f1', input))).not.toBe(a);
  });
  it('eviction removes journal entries too', async () => {
    const dir = tmp();
    const m = mk({ store: new FileJobStore(dir), runner: new FakeRunner({ failure: 'exit_nonzero' }), maxFinished: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(accept(m.submit('u1', `key-0000000${i}`, `f${i}`, input)));
      await until(() => m.status('u1', ids[i]!)?.state === 'failed');
    }
    expect(readdirSync(join(dir, 'jobs')).sort()).toEqual([`${ids[2]}.json`, `${ids[3]}.json`].sort());
    const m2 = mk({ store: new FileJobStore(dir), maxFinished: 2 });
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
  it('cancelled before save never reaches the saver', async () => {
    let saves = 0;
    const m = mk({ save: async () => (saves++, { batchId: 'x' }) });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input));
    m.cancel('u1', id);
    await new Promise(r => setTimeout(r, 30));
    expect(saves).toBe(0);
    expect(m.status('u1', id)?.state).toBe('cancelled');
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
    release({ batchId: 'b1' });
    for (let i = 0; i < 100; i++) {
      const s = (await app.inject({ url: `/local/v1/jobs/${jobId}`, headers: { host: HOST, cookie: h.cookie } })).json() as { state: string; batchId: string | null };
      if (s.state === 'succeeded') return expect(s.batchId).toBe('b1');
      await new Promise(r => setTimeout(r, 10));
    }
    throw new Error('never succeeded');
  });
  it('baseTripId / expectedRevision stay rejected (422) until A04 passes revisions through', async () => {
    const { app, h } = await start();
    for (const extra of [{ baseTripId: '00000000-0000-4000-8000-000000000000' }, { expectedRevision: 1 }]) {
      const r = await app.inject({ method: 'POST', url: '/local/v1/generations', payload: { constraints, ...extra }, headers: { ...h, 'idempotency-key': 'key-12345678' } });
      expect(r.statusCode).toBe(422);
    }
  });
});

describe('config', () => {
  it('AI_JOB_DIR is optional', () => {
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1' }).jobDir).toBeNull();
    expect(loadConfig({ PERSONAL_OWNER_USER_ID: 'u1', AI_JOB_DIR: '/x/y' }).jobDir).toBe('/x/y');
  });
});
