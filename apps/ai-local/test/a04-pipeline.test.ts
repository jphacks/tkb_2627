// A04 step 3: JobManager runs collect -> runner -> build -> save in order; failures before the runner never reach it.
import { describe, expect, it } from 'vitest';
import { FakeRunner, type Runner } from '@tkb/ai';
import { SCHEMA_VERSION, type GenerationInput, type PlanBatchCreate } from '@tkb/contracts';
import { samplePlanBlueprint } from '@tkb/fixtures';
import { JobManager, type GenerationPipeline, type JobRequest } from '../src/jobs/index.ts';
import type { JobMetrics } from '../src/generation/metrics.ts';

const request: JobRequest = {
  constraints: { area: 'SECRET-AREA', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
  baseTripId: null,
  baseRevision: null,
};
const placeIds = samplePlanBlueprint.candidates.flatMap(c => c.activityOrder);
const input: GenerationInput = { schemaVersion: SCHEMA_VERSION, constraints: request.constraints, allowedPlaceIds: placeIds, facts: [], fixedActivities: [], instructions: 'x' };
const batch = { schemaVersion: 1, baseTripId: null, baseRevision: null, generationId: 'g', candidates: [], places: [] } as unknown as PlanBatchCreate;

function setup(o: { pipeline?: Partial<GenerationPipeline>; runner?: Runner; timeoutMs?: number; metrics?: JobMetrics[] } = {}) {
  const log: string[] = [];
  let m!: JobManager;
  let jobId = '';
  // submit() starts the job synchronously, before jobId is known: look the stage up one tick later.
  const stage = () => m.status('u1', jobId)!.stage;
  const tick = () => new Promise<void>(r => setTimeout(r, 0));
  const pipeline: GenerationPipeline = {
    collect: async () => (await tick(), log.push(`collect@${stage()}`), { ok: true, input, ctx: { k: 1 }, info: { dataMode: 'fixture', sources: ['fixture'] } }),
    build: async (_o, _b, ctx) => (log.push(`build@${stage()}:${JSON.stringify(ctx)}`), { ok: true, batch, info: { candidates: 1, states: ['needs_review'] } }),
    save: async () => (log.push(`save@${stage()}`), { batchId: 'b-1' }),
    ...o.pipeline,
  };
  const runner: Runner = o.runner ?? { run: async (i, s) => (await tick(), log.push(`run@${stage()}`), new FakeRunner().run(i, s)) };
  m = new JobManager({ runner, queueLimit: 4, timeoutMs: o.timeoutMs ?? 5000, pipeline, onMetrics: x => o.metrics?.push(x) });
  const go = async () => {
    const r = m.submit('u1', 'key-00000001', 'f1', request);
    if (r.kind !== 'accepted') throw new Error('not accepted');
    jobId = r.jobId;
    for (let i = 0; i < 200; i++) {
      const s = m.status('u1', jobId)!;
      if (s.state === 'succeeded' || s.state === 'failed' || s.state === 'cancelled') return s;
      await new Promise(res => setTimeout(res, 10));
    }
    throw new Error('did not settle');
  };
  return { go, log };
}

describe('GenerationPipeline in JobManager', () => {
  it('runs collect, runner, build, save in stage order and succeeds with the saved batch id', async () => {
    const metrics: JobMetrics[] = [];
    const { go, log } = setup({ metrics });
    const s = await go();
    expect(s).toMatchObject({ state: 'succeeded', stage: 'done', batchId: 'b-1' });
    expect(log).toEqual(['collect@collecting_context', 'run@generating', 'build@validating:{"k":1}', 'save@saving']);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ state: 'succeeded', errorCode: null, info: { dataMode: 'fixture', candidates: 1 } });
    expect(JSON.stringify(metrics)).not.toContain('SECRET-AREA'); // metrics carry no request content
  });

  it('a K05 failure ends the job before Claude is run, with a fixed message and the stage failure flags', async () => {
    let ran = 0;
    const runner: Runner = { run: async () => (ran++, { exitCode: 0, envelope: null, durationMs: 1 }) };
    for (const [code, retryable] of [['PROVIDER_RATE_LIMIT', false], ['PROVIDER_UNAVAILABLE', true], ['CONSTRAINT_UNSATISFIED', false], ['RESTRICTED_ASSET', false], ['UNAUTHENTICATED', true]] as const) {
      const { go } = setup({ runner, pipeline: { collect: async () => ({ ok: false, code, retryable }) } });
      const s = await go();
      expect(s.state).toBe('failed');
      expect(s.stage).toBe('collecting_context');
      expect(s.error).toMatchObject({ code, retryable });
      expect(s.error!.message).not.toMatch(/SECRET/);
    }
    expect(ran).toBe(0);
  });

  it('a failed assembly stops at validating and nothing is saved', async () => {
    let saved = 0;
    const { go } = setup({ pipeline: { build: async () => ({ ok: false, code: 'INVALID_OUTPUT', retryable: true }), save: async () => (saved++, { batchId: 'x' }) } });
    const s = await go();
    expect(s).toMatchObject({ state: 'failed', stage: 'validating', error: { code: 'INVALID_OUTPUT' } });
    expect(saved).toBe(0);
  });

  it('the job deadline also covers collect: a hung K05 call ends as CLI_TIMEOUT without running Claude', async () => {
    let ran = 0;
    const { go } = setup({ timeoutMs: 40, runner: { run: async () => (ran++, { exitCode: 0, envelope: null, durationMs: 1 }) }, pipeline: { collect: () => new Promise(() => {}) } });
    const s = await go();
    expect(s).toMatchObject({ state: 'failed', error: { code: 'CLI_TIMEOUT' } });
    expect(ran).toBe(0);
  });

  it('an output that references a place not offered by collect is rejected before build', async () => {
    let built = 0;
    const { go } = setup({
      pipeline: { collect: async () => ({ ok: true, input: { ...input, allowedPlaceIds: ['only_this'] }, ctx: null }), build: async () => (built++, { ok: true, batch }) },
    });
    const s = await go();
    expect(s).toMatchObject({ state: 'failed', error: { code: 'INVALID_OUTPUT' } });
    expect(built).toBe(0);
  });

  it('without a pipeline a JobRequest fails UNAVAILABLE and the runner is not run', async () => {
    let ran = 0;
    const m = new JobManager({ runner: { run: async () => (ran++, { exitCode: 0, envelope: null, durationMs: 1 }) }, queueLimit: 2, timeoutMs: 1000 });
    const r = m.submit('u1', 'key-00000001', 'f1', request);
    if (r.kind !== 'accepted') throw new Error('x');
    await new Promise(res => setTimeout(res, 50));
    expect(m.status('u1', r.jobId)).toMatchObject({ state: 'failed', error: { code: 'UNAVAILABLE' } });
    expect(ran).toBe(0);
  });
});
