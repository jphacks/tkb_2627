import { describe, expect, it } from 'vitest';
import type { GenerationInput } from '@tkb/contracts';
import { samplePlanBlueprint } from '@tkb/fixtures';
import { FakeRunner, parseBlueprint } from '../src/index.ts';

const input = {} as GenerationInput;
const ids = ['fx_kenrokuen', 'fx_21c_museum', 'fx_omicho', 'fx_higashi'];
const ac = () => new AbortController();

describe('FakeRunner', () => {
  it('succeeds with sample blueprint', async () => {
    const r = await new FakeRunner().run(input, ac().signal);
    expect(r.exitCode).toBe(0);
    const p = parseBlueprint(r.envelope, ids);
    expect(p.ok && p.blueprint).toEqual(samplePlanBlueprint);
  });
  it('failure modes', async () => {
    const run = (failure: 'invalid_json' | 'exit_nonzero' | 'no_structured_output') =>
      new FakeRunner({ failure }).run(input, ac().signal);
    const a = await run('invalid_json');
    expect(parseBlueprint(a.envelope, ids).ok).toBe(false);
    const b = await run('no_structured_output');
    expect(parseBlueprint(b.envelope, ids).ok).toBe(false);
    const c = await run('exit_nonzero');
    expect(c.exitCode).toBe(1);
    expect(c.error?.code).toBe('CLI_EXIT');
  });
  it('timeout mode rejects on abort', async () => {
    const a = ac();
    const p = new FakeRunner({ failure: 'timeout' }).run(input, a.signal);
    a.abort();
    await expect(p).rejects.toThrow();
  });
  it('rejects when already aborted', async () => {
    const a = ac();
    a.abort();
    await expect(new FakeRunner().run(input, a.signal)).rejects.toThrow();
  });
});

describe('parseBlueprint', () => {
  it('rejects unknown place ids', async () => {
    const r = await new FakeRunner().run(input, ac().signal);
    const p = parseBlueprint(r.envelope, ['fx_kenrokuen']);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error.code).toBe('INVALID_OUTPUT');
  });
});
