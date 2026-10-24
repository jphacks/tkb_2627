// T04-1: fake Claude Code 2.1.301 envelopes through the personal entry (HTTP) and parseBlueprint.
// Every rejected output must end as failed with a fixed message and never echo raw model/CLI text.
import { afterEach, describe, expect, it } from 'vitest';
import { parseBlueprint } from '@tkb/ai';
import { closeAll, envelope, goodBlueprint, make, ok, placeIds, returning, runnerOf, session, settle, submit } from './harness.ts';

afterEach(closeAll);

const RAW = 'RAW-MODEL-TEXT-SHOULD-NEVER-LEAK';
const FIXED = {
  INVALID_OUTPUT: 'The generator returned an invalid result.',
  CLI_EXIT: 'The generator exited with an error.',
} as const;

async function runWith(env: unknown, o: { saved?: string[] } = {}) {
  const { runner, calls } = returning(env);
  const saved = o.saved ?? [];
  const c = make({ app: { runner, save: async ctx => (saved.push(ctx.jobId), { batchId: 'batch-1' }) } });
  const { h } = await session(c);
  const job = await settle(c, h, await submit(c, h));
  return { job, calls, saved };
}

const withBp = (mut: (b: ReturnType<typeof goodBlueprint>) => unknown) => envelope({ structured_output: mut(goodBlueprint()) });

describe('rejected outputs end failed/INVALID_OUTPUT with a fixed message', () => {
  const cases: [string, unknown][] = [
    ['structured_output is an invalid JSON string', envelope({ structured_output: `{not json ${RAW}` })],
    ['structured_output is a JSON string (must be an object)', envelope({ structured_output: JSON.stringify(goodBlueprint()) })],
    ['structured_output missing (text only result)', (() => { const e = envelope({ result: RAW }); delete e.structured_output; return e; })()],
    ['envelope is null', null],
    ['envelope is a string', RAW],
    ['envelope is an array', [envelope()]],
    ['structured_output null', envelope({ structured_output: null })],
    ['hallucinated place id', withBp(b => ((b.candidates[0]!.activityOrder[0] = 'place_made_up_by_model'), b))],
    ['hallucinated excludedPlaceIds', withBp(b => ((b.candidates[1]!.excludedPlaceIds = ['ghost_place']), b))],
    ['duplicate activityOrder', withBp(b => ((b.candidates[0]!.activityOrder = [placeIds[0]!, placeIds[0]!]), b))],
    ['empty activityOrder', withBp(b => ((b.candidates[0]!.activityOrder = []), b))],
    ['4 candidates (>3)', withBp(b => ((b.candidates = [0, 1, 2, 3].map(i => ({ ...b.candidates[0]!, candidateId: `c${i}` }))), b))],
    ['0 candidates', withBp(b => ((b.candidates = []), b))],
    ['wrong schemaVersion', withBp(b => ({ ...b, schemaVersion: 2 }))],
    ['candidates not an array', withBp(b => ({ ...b, candidates: { 0: b.candidates[0] } }))],
    ['huge output with unknown places', withBp(b => ((b.candidates[0]!.activityOrder = Array.from({ length: 50_000 }, (_, i) => `x${i}`)), b))],
  ];
  for (const [name, env] of cases) {
    it(name, async () => {
      const { job, saved } = await runWith(env);
      expect(job.state).toBe('failed');
      expect(job.batchId).toBeNull();
      expect(job.error?.code).toBe('INVALID_OUTPUT');
      expect(job.error?.message).toBe(FIXED.INVALID_OUTPUT);
      expect(job.error?.retryable).toBe(true);
      expect(JSON.stringify(job)).not.toContain(RAW);
      expect(saved).toEqual([]);
    });
  }
});

describe('accepted shapes', () => {
  it('well-formed envelope with extra unknown keys is accepted and saved', async () => {
    const { job, saved } = await runWith(envelope({ future_key: { a: 1 }, modelUsage: {}, usage: { input_tokens: 1 } }));
    expect(job.state).toBe('succeeded');
    expect(job.batchId).toBe('batch-1');
    expect(saved).toHaveLength(1);
  });
  it('extra unknown keys inside structured_output are tolerated or rejected, never crash', () => {
    const r = parseBlueprint(envelope({ structured_output: { ...goodBlueprint(), extra: 1 } }), placeIds);
    expect(typeof r.ok).toBe('boolean');
  });
  it('1-3 candidates are accepted', () => {
    const b = goodBlueprint();
    expect(parseBlueprint(envelope({ structured_output: { ...b, candidates: [b.candidates[0]] } }), placeIds).ok).toBe(true);
  });
});

// docs/claude-connection-check.md: accept ONLY exit 0 + type=result + is_error=false + subtype=success + structured_output.
// BUG-T04-1 (found by T04, fixed in packages/ai/src/parse-blueprint.ts): envelope status fields used to be ignored.
describe('envelope status fields (spec: all of type/is_error/subtype must be success)', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['is_error:true with structured_output present', { is_error: true }],
    ['subtype error_max_turns with structured_output present', { subtype: 'error_max_turns' }],
    ['subtype error_during_execution', { subtype: 'error_during_execution' }],
    ["type is not 'result'", { type: 'system' }],
    ['stop_reason max_tokens / api_error_status 529', { api_error_status: 529, is_error: true }],
  ];
  for (const [name, over] of bad) {
    it(`BUG-T04-1 (fixed): ${name} must not succeed`, async () => {
      const { job, saved } = await runWith(envelope(over));
      expect(saved).toEqual([]);
      expect(job.state).toBe('failed');
    });
    it(`BUG-T04-1 (fixed): parseBlueprint rejects ${name}`, () => {
      expect(parseBlueprint(envelope(over), placeIds).ok).toBe(false);
    });
  }
});

describe('runner-reported failures', () => {
  it('non-zero exit with runner SafeError keeps the code but replaces the message', async () => {
    const { runner } = runnerOf(async () => ({
      exitCode: 1,
      envelope: null,
      durationMs: 1,
      error: { code: 'CLI_NOT_AUTHENTICATED', message: `${RAW} /home/x/.claude/.credentials.json`, retryable: false, requestId: 'r' },
    }));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const job = await settle(c, h, await submit(c, h));
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('CLI_NOT_AUTHENTICATED');
    expect(JSON.stringify(job)).not.toMatch(/RAW-MODEL|credentials/);
  });
  it('exit non-zero without error becomes CLI_EXIT', async () => {
    const { runner } = runnerOf(async () => ({ exitCode: 137, envelope: envelope(), durationMs: 1 }));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const job = await settle(c, h, await submit(c, h));
    expect(job.error?.code).toBe('CLI_EXIT');
    expect(job.error?.message).toBe(FIXED.CLI_EXIT);
  });
  it('ok() helper envelope with exit 0 but valid output and no saver is UNAVAILABLE, not succeeded', async () => {
    const { runner } = runnerOf(async () => ok(envelope()));
    const c = make({ app: { runner } });
    const { h } = await session(c);
    const job = await settle(c, h, await submit(c, h));
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('UNAVAILABLE');
  });
});
