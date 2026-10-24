import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, type GenerationInput } from '@tkb/contracts';
import { FakeRunner, type Runner } from '@tkb/ai';
import { JobManager } from '../src/jobs/index.ts';

const input: GenerationInput = {
  schemaVersion: SCHEMA_VERSION,
  constraints: { area: 'x', startDate: '2026-11-01', endDate: '2026-11-02', timeZone: 'Asia/Tokyo', transportMode: 'transit' },
  allowedPlaceIds: [],
  facts: [],
  fixedActivities: [],
  instructions: 'x',
};
const mgr = (runner: Runner, o: Partial<ConstructorParameters<typeof JobManager>[0]> = {}) =>
  new JobManager({ runner, queueLimit: 8, timeoutMs: 60_000, ...o });
const stuck = new FakeRunner({ failure: 'timeout' });
const never: Runner = { run: () => new Promise(() => {}) }; // ignores AbortSignal
const until = async (f: () => boolean) => {
  for (let i = 0; i < 200 && !f(); i++) await new Promise(r => setTimeout(r, 10));
  expect(f()).toBe(true);
};
const accept = (r: ReturnType<JobManager['submit']>) => {
  if (r.kind !== 'accepted') throw new Error(r.kind);
  return r.jobId;
};

describe('JobManager owner isolation', () => {
  it('status and cancel are owner-scoped', () => {
    const m = mgr(stuck);
    const id = accept(m.submit('u1', 'key-12345678', 'f', input));
    expect(m.status('u1', id)?.jobId).toBe(id);
    expect(m.status('u2', id)).toBeNull();
    expect(m.cancel('u2', id)).toBeNull();
    expect(m.status('u1', id)?.state).toBe('running');
    expect(m.cancel('u1', id)?.wasActive).toBe(true);
    expect(m.cancel('u1', id)?.wasActive).toBe(false);
  });
  it('idempotency keys are per owner', () => {
    const m = mgr(stuck);
    const a = accept(m.submit('u1', 'key-12345678', 'f1', input));
    const b = accept(m.submit('u2', 'key-12345678', 'f2', input));
    expect(a).not.toBe(b);
    expect(accept(m.submit('u1', 'key-12345678', 'f1', input))).toBe(a);
    expect(m.submit('u1', 'key-12345678', 'other', input).kind).toBe('conflict');
  });
});

describe('JobManager lifecycle', () => {
  it('usage limit from the runner fails the job with CLI_LIMIT (no fallback, no retry)', async () => {
    let calls = 0;
    const limited: Runner = {
      run: async () => {
        calls++;
        return {
          exitCode: 1,
          envelope: null,
          durationMs: 1,
          error: { code: 'CLI_LIMIT', message: 'Usage limit reached.', retryable: false, requestId: 'x' },
        };
      },
    };
    const m = mgr(limited);
    const id = accept(m.submit('u1', 'key-limit001', 'f1', input));
    await until(() => m.status('u1', id)?.state === 'failed');
    expect(m.status('u1', id)?.error?.code).toBe('CLI_LIMIT');
    expect(calls).toBe(1);
  });
  it('a runner that ignores AbortSignal cannot block the queue', async () => {
    const m = mgr(never, { timeoutMs: 40 });
    const a = accept(m.submit('u1', 'key-00000001', 'f1', input));
    const b = accept(m.submit('u1', 'key-00000002', 'f2', input));
    await until(() => m.status('u1', a)?.state === 'failed');
    expect(m.status('u1', a)?.error?.code).toBe('CLI_TIMEOUT');
    await until(() => m.status('u1', b)?.state === 'failed');
  });
  it('deadline counts from submit: queued job times out while waiting', async () => {
    const m = mgr(never, { timeoutMs: 40, queueLimit: 1 });
    accept(m.submit('u1', 'key-00000001', 'f1', input));
    const b = accept(m.submit('u1', 'key-00000002', 'f2', input));
    await until(() => m.status('u1', b)?.state === 'failed');
    expect(m.status('u1', b)?.error?.code).toBe('CLI_TIMEOUT');
  });
  it('requestId on errors is the submitting request id', async () => {
    const m = mgr(new FakeRunner({ failure: 'invalid_json' }), { allowedPlaceIds: [] });
    const id = accept(m.submit('u1', 'key-00000001', 'f1', input, 'req-123'));
    await until(() => m.status('u1', id)?.state === 'failed');
    expect(m.status('u1', id)?.error?.requestId).toBe('req-123');
  });
  it('evicts oldest terminal jobs together with their idempotency entries', async () => {
    const m = mgr(new FakeRunner({ failure: 'exit_nonzero' }), { maxFinished: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      ids.push(accept(m.submit('u1', `key-0000000${i}`, `f${i}`, input)));
      await until(() => m.status('u1', ids[i]!)?.state === 'failed');
    }
    expect(m.status('u1', ids[0]!)).toBeNull();
    expect(m.status('u1', ids[1]!)).toBeNull();
    expect(m.status('u1', ids[3]!)).not.toBeNull();
    // evicted key is reusable (new job)
    expect(accept(m.submit('u1', 'key-00000000', 'f0', input))).not.toBe(ids[0]);
  });
});
